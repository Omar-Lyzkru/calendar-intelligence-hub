import { Prisma } from "@prisma/client";
import { Temporal } from "@js-temporal/polyfill";
import {
  AppError,
  QuestionAnswerSchema,
  EditableEventDraftSchema,
  ReadyEventSchema,
  chooseLocalTime,
  type Actor,
  type EventDraft,
  type QuestionAnswer,
} from "@hub/contracts";
import { db } from "../../infrastructure/persistence/db.js";
import { getReview } from "../../infrastructure/persistence/reviews.js";
import { saveReview, ignoreReview } from "../approveReview.js";
import { checkDuplicates } from "../checkDuplicates.js";
import { getPolicy } from "./policyStore.js";
import { withActionLock } from "./actionLock.js";
import { evaluateReview, type AutomationOptions } from "./engine.js";
import { advisoryFingerprint } from "./questionStore.js";
import type { CalendarGateway } from "../../infrastructure/google/calendar.js";
function dateAnswer(draft: EventDraft, value: string): EventDraft["temporal"] {
  const date = Temporal.PlainDate.from(value);
  const t = draft.temporal;
  if (t.kind !== "unresolved") throw new AppError("invalid_input", 422);
  const partial = {
    ...t.partial,
    year: date.year,
    month: date.month,
    day: date.day,
  };
  if (partial.startClock && t.timezoneProvenance === "explicit") {
    const start = chooseLocalTime(
      date.toString() + "T" + partial.startClock,
      t.timezone,
      "reject",
    );
    const end = partial.endClock
      ? chooseLocalTime(
          (partial.endDateInclusive || date.toString()) +
            "T" +
            partial.endClock,
          t.timezone,
          "reject",
        )
      : null;
    if (start.ok && (!end || end.ok))
      return {
        kind: "timed",
        start: start.instant,
        end: end?.ok ? end.instant : null,
        timezone: t.timezone,
        timezoneProvenance: "explicit",
      };
  }
  return {
    kind: "unresolved",
    text: "",
    timezone: t.timezone,
    timezoneProvenance: t.timezoneProvenance,
    partial,
  };
}
export async function answerQuestion(
  actor: Actor,
  id: string,
  input: { expectedRevision: number; answer: QuestionAnswer },
  calendar: CalendarGateway,
  options: AutomationOptions = {},
) {
  const answer = QuestionAnswerSchema.parse(input.answer);
  return withActionLock(actor, async () => {
    const q = await db.automationQuestion.findFirst({
      where: { id, userId: actor.userId },
      include: {
        decision: { include: { message: { include: { observation: true } } } },
      },
    });
    if (!q) throw new AppError("not_found", 404);
    const policy = await getPolicy(actor);
    const detail = q.decision.reviewId
      ? await getReview(actor, q.decision.reviewId)
      : null;
    if (
      q.status !== "open" ||
      !detail ||
      detail.revision !== input.expectedRevision ||
      detail.revision !== q.reviewRevision ||
      policy.revision !== q.policyRevision ||
      (q.decision.message.observation?.sourceRevision || 1) !== q.sourceRevision
    )
      throw new AppError("stale_review", 409);
    const old = q.decision;
    const fields = new Set(
      old.confirmedRevision === detail.revision ? old.confirmedFields : [],
    );
    let draft: EventDraft = { ...detail.draft };
    let changed = false;
    let ignored = false;
    let accepted: {
      duplicateFingerprint?: string;
      conflictFingerprint?: string;
    } = {};
    if (answer.kind === "skip") {
      if (detail.status !== "needs_review")
        throw new AppError("review_locked", 409);
      ignored = true;
    } else if (q.kind === "title" && answer.kind === "title") {
      draft.title = answer.value;
      fields.add("title");
      changed = true;
    } else if (q.kind === "date" && answer.kind === "date") {
      try {
        draft.temporal = dateAnswer(draft, answer.value);
      } catch {
        throw new AppError("invalid_input", 422);
      }
      if (draft.temporal.kind === "timed" && draft.temporal.end)
        fields.add("temporal");
      changed = true;
    } else if (
      ["time", "timezone", "all_day"].includes(q.kind) &&
      answer.kind === "temporal"
    ) {
      const parsed = ReadyEventSchema.shape.temporal.safeParse(answer.value);
      if (!parsed.success) throw new AppError("invalid_input", 422);
      draft.temporal =
        parsed.data.kind === "timed"
          ? { ...parsed.data, timezoneProvenance: "user_confirmed" }
          : parsed.data;
      fields.add("temporal");
      changed = true;
    } else if (q.kind === "all_day" && answer.kind === "all_day") {
      if (draft.temporal.kind !== "date_only")
        throw new AppError("stale_review", 409);
      draft.temporal = {
        kind: "all_day",
        startDate: draft.temporal.startDate,
        endExclusive: Temporal.PlainDate.from(
          draft.temporal.endDateInclusive || draft.temporal.startDate,
        )
          .add({ days: 1 })
          .toString(),
      };
      fields.add("temporal");
      changed = true;
    } else if (q.kind === "category" && answer.kind === "category") {
      draft.eventCategory = answer.value;
      fields.add("category");
      changed = true;
    } else if (
      q.kind === "facts" &&
      answer.kind === "confirm" &&
      answer.value
    ) {
      fields.add("title");
      fields.add("temporal");
      fields.add("category");
      if (q.advisoryFingerprint === "reason:source_untrusted")
        fields.add("permission");
    } else if (
      (q.kind === "duplicate" || q.kind === "conflict") &&
      answer.kind === "confirm" &&
      answer.value
    ) {
      const checks = await checkDuplicates(
        actor,
        detail.id,
        detail.revision,
        calendar,
      );
      const fingerprint = advisoryFingerprint(checks, q.kind);
      if (
        fingerprint !== q.advisoryFingerprint ||
        checks.local.status !== "checked" ||
        checks.google.status !== "checked" ||
        checks.conflicts?.local.status !== "checked" ||
        checks.conflicts.google.status !== "checked" ||
        checks.truncated ||
        checks.conflicts.truncated
      ) {
        await db.automationQuestion.update({
          where: { id: q.id },
          data: { status: "invalidated", closedAt: new Date() },
        });
        return evaluateReview(actor, detail.id, calendar, options);
      }
      fields.add("permission");
      accepted =
        q.kind === "duplicate"
          ? { duplicateFingerprint: fingerprint }
          : { conflictFingerprint: fingerprint };
    } else throw new AppError("invalid_input", 422);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "ReviewItem" WHERE id=${detail.id}::uuid AND "userId"=${actor.userId}::uuid FOR UPDATE`,
      );
      const current = await tx.reviewItem.findFirst({
        where: { id: detail.id, userId: actor.userId },
        select: { revision: true },
      });
      const observation = await tx.discordObservation.findUnique({
        where: { messageId: detail.messageId },
      });
      if (
        current?.revision !== detail.revision ||
        (observation?.sourceRevision || 1) !== q.sourceRevision
      )
        throw new AppError("stale_review", 409);
      let revision = detail.revision;
      if (ignored)
        revision = (await ignoreReview(actor, detail.id, detail.revision, tx))
          .revision;
      else if (changed)
        revision = (
          await saveReview(
            actor,
            detail.id,
            detail.revision,
            EditableEventDraftSchema.parse(draft),
            tx,
          )
        ).revision;
      const result = await tx.automationQuestion.updateMany({
        where: { id: q.id, status: "open" },
        data: { status: "answered", closedAt: new Date() },
      });
      if (result.count !== 1) throw new AppError("stale_review", 409);
      await tx.automationDecision.update({
        where: { id: old.id },
        data: {
          confirmedFields: [...fields],
          confirmedRevision: revision,
          ...accepted,
        },
      });
      await tx.historyEntry.create({
        data: {
          userId: actor.userId,
          reviewId: detail.id,
          action: "automation_question_answered",
          actor: "user",
        },
      });
    });
    return evaluateReview(actor, detail.id, calendar, options);
  });
}
