import type { Express } from "express";
import type { CalendarGateway } from "../infrastructure/google/calendar.js";
import { checkDuplicates } from "../application/checkDuplicates.js";
import { createCalendarEvent } from "../application/createCalendarEvent.js";
import { z } from "zod";
import { EditableEventDraftSchema, historyDisplay } from "@hub/contracts";
import { requireActor } from "../middleware/auth.js";
import { db } from "../infrastructure/persistence/db.js";
import { getReview } from "../infrastructure/persistence/reviews.js";
import { deleteContent } from "../infrastructure/persistence/retention.js";
import {
  saveReview,
  approveReview,
  ignoreReview,
} from "../application/approveReview.js";
const revision = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
const id = (v: unknown) => z.uuid().parse(v);
export function reviewRoutes(app: Express, calendar: CalendarGateway) {
  app.post("/api/reviews/:id/duplicates", requireActor, async (req, res) => {
    const input = revision
      .extend({ draft: EditableEventDraftSchema.optional() })
      .parse(req.body);
    res.json(
      await checkDuplicates(
        res.locals.actor,
        id(req.params.id),
        input.expectedRevision,
        calendar,
        input.draft,
      ),
    );
  });
  app.post("/api/reviews/:id/calendar", requireActor, async (req, res) =>
    res.json(
      await createCalendarEvent(res.locals.actor, id(req.params.id), calendar),
    ),
  );
  app.get("/api/reviews", requireActor, async (req, res) => {
    const cursor = z.uuid().optional().parse(req.query.cursor);
    const rows = await db.reviewItem.findMany({
      where: { userId: res.locals.actor.userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 21,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    res.json({
      items: await Promise.all(
        rows.slice(0, 20).map(async (r) => {
          const detail = await getReview(res.locals.actor, r.id);
          return {
            id: r.id,
            status: r.status,
            title: detail.draft.title,
            category: detail.draft.category,
            ...(detail.draft.eventCategory !== undefined
              ? { eventCategory: detail.draft.eventCategory }
              : {}),
            state: detail.state,
            write: detail.write,
          };
        }),
      ),
      nextCursor: rows.length > 20 ? rows[19].id : null,
    });
  });
  app.get("/api/reviews/:id", requireActor, async (req, res) =>
    res.json(await getReview(res.locals.actor, id(req.params.id))),
  );
  app.patch("/api/reviews/:id", requireActor, async (req, res) => {
    const input = revision
      .extend({ draft: EditableEventDraftSchema })
      .parse(req.body);
    res.json(
      await saveReview(
        res.locals.actor,
        id(req.params.id),
        input.expectedRevision,
        input.draft,
      ),
    );
  });
  app.post("/api/reviews/:id/approve", requireActor, async (req, res) =>
    res.json(
      await approveReview(
        res.locals.actor,
        id(req.params.id),
        revision.parse(req.body).expectedRevision,
      ),
    ),
  );
  app.post("/api/reviews/:id/ignore", requireActor, async (req, res) =>
    res.json(
      await ignoreReview(
        res.locals.actor,
        id(req.params.id),
        revision.parse(req.body).expectedRevision,
      ),
    ),
  );
  app.delete("/api/messages/:id/content", requireActor, async (req, res) => {
    await deleteContent(res.locals.actor.userId, id(req.params.id));
    res.sendStatus(204);
  });
  app.get("/api/history", requireActor, async (req, res) => {
    const cursor = z.uuid().optional().parse(req.query.cursor);
    const rows = await db.historyEntry.findMany({
      where: { userId: res.locals.actor.userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 21,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        action: true,
        reason: true,
        actor: true,
        createdAt: true,
        reviewId: true,
      },
    });
    res.json({
      items: rows
        .slice(0, 20)
        .map((r) => ({ ...r, ...historyDisplay(r.action, r.reason) })),
      nextCursor: rows.length > 20 ? rows[19].id : null,
    });
  });
}
