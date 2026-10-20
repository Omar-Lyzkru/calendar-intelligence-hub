import { z } from "zod";
import { AppError, type Actor } from "@hub/contracts";
import { db, json } from "../../infrastructure/persistence/db.js";
import type { GmailGateway } from "../../infrastructure/google/gmail.js";
import type { CalendarGateway } from "../../infrastructure/google/calendar.js";
import { importMessages } from "../importMessages.js";
import { evaluateReview, type AutomationOptions } from "./engine.js";
import { getPolicy } from "./policyStore.js";
import { withScopedLock, withActionLock } from "./actionLock.js";
const pageSchema = z
  .object({
    ids: z.array(z.string().min(1).max(128)).max(20),
    nextPageToken: z.string().min(1).max(2048).optional(),
  })
  .strict();
const retryReasons = [
  "checks_unavailable",
  "stale",
  "action_unknown",
  "action_failed",
  "action_pending",
  "source_unavailable",
];
export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private work: Promise<void> | undefined;
  private stopped = false;
  constructor(
    private deps: {
      gmail: GmailGateway;
      calendar: CalendarGateway;
      now?: () => Date;
    } & AutomationOptions,
  ) {}
  private now() {
    return new Date(this.deps.now?.() || new Date());
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, 60000);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.work;
  }
  async tick(actor?: Actor) {
    if (this.stopped || this.work) return;
    this.work = this.run(actor)
      .catch(() => {
        console.error(
          JSON.stringify({ code: "automation_scheduler_unavailable" }),
        );
      })
      .finally(() => {
        this.work = undefined;
      });
    await this.work;
  }
  private async run(actor?: Actor) {
    const owner = actor ? { userId: actor.userId } : {};
    const missing = await db.sourceConnection.findMany({
      where: {
        ...owner,
        provider: "gmail",
        status: "connected",
        ingestionPoll: { is: null },
        user: { automationPolicy: { is: { enabled: true, pollGmail: true } } },
      },
      include: { user: { include: { automationPolicy: true } } },
      take: 20,
    });
    for (const c of missing) {
      const enabledAt = c.user.automationPolicy?.gmailPollingEnabledAt;
      if (enabledAt)
        await db.ingestionPoll.upsert({
          where: { connectionId: c.id },
          create: {
            connectionId: c.id,
            userId: c.userId,
            watermark: enabledAt,
            nextRunAt: this.now(),
          },
          update: {},
        });
    }
    const polls = await db.ingestionPoll.findMany({
      where: {
        ...owner,
        status: { not: "blocked" },
        nextRunAt: { lte: this.now() },
        connection: { status: "connected", provider: "gmail" },
        user: { automationPolicy: { is: { enabled: true, pollGmail: true } } },
      },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      take: 20,
    });
    for (const poll of polls) {
      if (this.stopped) return;
      await withScopedLock(
        "mail-poll:" + poll.connectionId,
        () => this.poll(poll.id),
        true,
      );
    }
    if (this.stopped) return;
    // Decisions run after the poll lock is released: no nested lock-pool starvation.
    const where = {
      ...owner,
      status: { in: ["review", "no_event"] },
      user: { automationPolicy: { is: { enabled: true } } },
    };
    const unseen = await db.normalizedMessage.findMany({
      where: { ...where, automationDecision: { is: null } },
      orderBy: [{ ingestedAt: "asc" }, { id: "asc" }],
      take: 20,
      select: {
        id: true,
        userId: true,
        status: true,
        detected: { select: { review: { select: { id: true } } } },
      },
    });
    const retries =
      unseen.length < 20
        ? await db.normalizedMessage.findMany({
            where: {
              ...where,
              automationDecision: {
                is: { decision: "blocked", reason: { in: retryReasons } },
              },
            },
            orderBy: { automationDecision: { updatedAt: "asc" } },
            take: 20 - unseen.length,
            select: {
              id: true,
              userId: true,
              status: true,
              detected: { select: { review: { select: { id: true } } } },
            },
          })
        : [];
    for (const m of [...unseen, ...retries]) {
      if (this.stopped) return;
      if (m.detected?.review)
        await evaluateReview(
          { userId: m.userId },
          m.detected.review.id,
          this.deps.calendar,
          { allowWrites: this.deps.allowWrites },
        );
      else
        await withActionLock({ userId: m.userId }, async () => {
          const policy = await getPolicy({ userId: m.userId });
          if (!policy.enabled) return;
          await db.automationDecision.upsert({
            where: { messageId: m.id },
            create: {
              userId: m.userId,
              messageId: m.id,
              reviewRevision: 0,
              policyRevision: policy.revision,
              decision: m.status === "no_event" ? "skip" : "blocked",
              reason: m.status === "no_event" ? "no_event" : "record_problem",
              evidence: json({
                policyRevision: policy.revision,
                processing:
                  m.status === "no_event" ? "no_event" : "missing_review",
              }),
            },
            update: {},
          });
        });
    }
  }
  private async poll(id: string) {
    let state = await db.ingestionPoll.findUniqueOrThrow({ where: { id } });
    if (
      state.status === "blocked" ||
      state.nextRunAt > this.now() ||
      this.stopped
    )
      return;
    const actor = { userId: state.userId };
    const policy = await getPolicy(actor);
    if (!policy.enabled || !policy.pollGmail || !policy.gmailPollingEnabledAt)
      return;
    const active = async () => {
      const p = await getPolicy(actor);
      const c = await db.sourceConnection.findUnique({
        where: { id: state.connectionId },
      });
      return (
        !this.stopped &&
        p.enabled &&
        p.pollGmail &&
        p.revision === policy.revision &&
        c?.status === "connected"
      );
    };
    if (!(await active())) return;
    try {
      if (state.watermark < policy.gmailPollingEnabledAt)
        state = await db.ingestionPoll.update({
          where: { id },
          data: {
            watermark: policy.gmailPollingEnabledAt,
            windowEnd: null,
            pageToken: null,
            pendingIds: [],
            failures: 0,
          },
        });
      if (!state.windowEnd) {
        const end = new Date(
          Math.min(state.watermark.valueOf() + 3600000, this.now().valueOf()),
        );
        if (end <= state.watermark) {
          await db.ingestionPoll.update({
            where: { id },
            data: { nextRunAt: new Date(this.now().valueOf() + 60000) },
          });
          return;
        }
        state = await db.ingestionPoll.update({
          where: { id },
          data: { windowEnd: end },
        });
      }
      if (!state.pendingIds.length) {
        if (!this.deps.gmail.poll)
          throw new AppError("gmail_list_unavailable", 503);
        const page = pageSchema.parse(
          await this.deps.gmail.poll(actor, {
            after: state.watermark.toISOString(),
            before: state.windowEnd!.toISOString(),
            ...(state.pageToken ? { pageToken: state.pageToken } : {}),
          }),
        );
        if (page.nextPageToken && page.nextPageToken === state.pageToken)
          throw new AppError("gmail_list_unavailable", 503);
        state = await db.ingestionPoll.update({
          where: { id },
          data: {
            pendingIds: [...new Set(page.ids)],
            pageToken: page.nextPageToken || null,
          },
        });
      }
      const pending = [...state.pendingIds];
      while (pending.length) {
        if (!(await active())) return;
        const result = await importMessages(actor, [pending[0]], {
          ...this.deps.gmail,
          get: async (a, externalId) => {
            const payload = await this.deps.gmail.get(a, externalId);
            if (!(await active()))
              throw new AppError("provider_unavailable", 503);
            return payload;
          },
        });
        if (!(await active())) return;
        if (result.items[0]?.status === "failed")
          throw new AppError(
            result.items[0].reason || "gmail_fetch_unavailable",
            503,
          );
        pending.shift();
        await db.ingestionPoll.update({
          where: { id },
          data: { pendingIds: pending },
        });
      }
      if (!(await active())) return;
      await db.ingestionPoll.update({
        where: { id },
        data: {
          ...(!state.pageToken
            ? { watermark: state.windowEnd!, windowEnd: null }
            : {}),
          pendingIds: [],
          failures: 0,
          status: "ready",
          nextRunAt: new Date(this.now().valueOf() + 60000),
        },
      });
    } catch (error) {
      const failures = state.failures + 1;
      const terminal =
        failures >= 5 ||
        (error instanceof AppError &&
          [
            "reauthorization_required",
            "microsoft_reauthorization_required",
          ].includes(error.code));
      await db.ingestionPoll.update({
        where: { id },
        data: {
          failures,
          status: terminal ? "blocked" : "retry",
          nextRunAt: new Date(
            this.now().valueOf() +
              Math.min(3600000, 60000 * 2 ** (failures - 1)),
          ),
        },
      });
      await db.historyEntry.create({
        data: {
          userId: actor.userId,
          action: "automation_poll_problem",
          reason: "poll_unavailable",
          actor: "automation",
        },
      });
    }
  }
}
