import type { Express } from "express";
import { z } from "zod";
import {
  AutomationPolicyInputSchema,
  QuestionAnswerSchema,
  AppError,
} from "@hub/contracts";
import { requireActor } from "../middleware/auth.js";
import {
  getPolicy,
  savePolicy,
} from "../application/automation/policyStore.js";
import {
  evaluateReview,
  type AutomationOptions,
} from "../application/automation/engine.js";
import { answerQuestion } from "../application/automation/questions.js";
import { listActivity } from "../application/automation/activity.js";
import { db } from "../infrastructure/persistence/db.js";
import { withActionLock } from "../application/automation/actionLock.js";
import type { CalendarGateway } from "../infrastructure/google/calendar.js";
const revision = z.number().int().positive();
export function automationRoutes(
  app: Express,
  calendar: CalendarGateway,
  options: AutomationOptions = {},
  control?: { tick(actor?: import("@hub/contracts").Actor): Promise<void> },
) {
  app.post("/api/automation/run", requireActor, async (req, res) => {
    z.object({}).strict().parse(req.body);
    if (!control) throw new AppError("provider_unavailable", 503);
    void control.tick(res.locals.actor);
    res.status(202).json({ status: "scheduled" });
  });
  app.get("/api/automation/policy", requireActor, async (_req, res) => {
    const p = await getPolicy(res.locals.actor);
    res.json({
      enabled: p.enabled,
      pollGmail: p.pollGmail,
      rules: p.rules,
      revision: p.revision,
      enabledAt: p.enabledAt?.toISOString() || null,
      liveWritesEnabled: options.allowWrites === true,
    });
  });
  app.put("/api/automation/policy", requireActor, async (req, res) => {
    const input = AutomationPolicyInputSchema.extend({
      expectedRevision: revision,
    }).parse(req.body);
    const p = await savePolicy(res.locals.actor, input.expectedRevision, {
      enabled: input.enabled,
      pollGmail: input.pollGmail,
      rules: input.rules,
    });
    res.json({
      enabled: p.enabled,
      pollGmail: p.pollGmail,
      rules: p.rules,
      revision: p.revision,
      enabledAt: p.enabledAt?.toISOString() || null,
      liveWritesEnabled: options.allowWrites === true,
    });
  });
  app.get("/api/automation/sources", requireActor, async (_req, res) => {
    const connections = await db.sourceConnection.findMany({
      where: { userId: res.locals.actor.userId },
      include: { discordRelay: { select: { channelIds: true } } },
      take: 30,
    });
    res.json({
      items: connections.map((c) => ({
        id: c.id,
        provider: c.provider,
        status: c.status,
        channelIds: c.discordRelay?.channelIds || [],
      })),
    });
  });
  app.get("/api/automation/activity", requireActor, async (req, res) =>
    res.json(
      await listActivity(
        res.locals.actor,
        z.uuid().optional().parse(req.query.cursor),
      ),
    ),
  );
  app.post(
    "/api/automation/reviews/:id/evaluate",
    requireActor,
    async (req, res) => {
      z.object({}).strict().parse(req.body);
      res.json(
        await evaluateReview(
          res.locals.actor,
          z.uuid().parse(req.params.id),
          calendar,
          options,
        ),
      );
    },
  );
  app.post(
    "/api/automation/questions/:id/answer",
    requireActor,
    async (req, res) => {
      const input = z
        .object({ expectedRevision: revision, answer: QuestionAnswerSchema })
        .strict()
        .parse(req.body);
      res.json(
        await answerQuestion(
          res.locals.actor,
          z.uuid().parse(req.params.id),
          input,
          calendar,
          options,
        ),
      );
    },
  );
  app.post(
    "/api/automation/polls/:id/retry",
    requireActor,
    async (req, res) => {
      z.object({}).strict().parse(req.body);
      await withActionLock(res.locals.actor, async () => {
        const row = await db.ingestionPoll.findFirst({
          where: {
            connectionId: z.uuid().parse(req.params.id),
            userId: res.locals.actor.userId,
          },
        });
        if (!row) throw new AppError("not_found", 404);
        await db.ingestionPoll.update({
          where: { id: row.id },
          data: { status: "retry", failures: 0, nextRunAt: new Date() },
        });
      });
      res.json({ status: "retry" });
    },
  );
}
