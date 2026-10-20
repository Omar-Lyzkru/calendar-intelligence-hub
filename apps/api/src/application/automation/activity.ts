import {
  AUTOMATION_REASON_LABELS,
  EVENT_CATEGORY_LABELS,
  EventCategorySchema,
  AutomationActivitySchema,
  QuestionKindSchema,
  AutomationReasonSchema,
  type Actor,
  type EventDraft,
} from "@hub/contracts";
import { db } from "../../infrastructure/persistence/db.js";
import { getPolicy } from "./policyStore.js";
export async function listActivity(actor: Actor, cursor?: string) {
  const policy = await getPolicy(actor);
  const rows = await db.automationDecision.findMany({
    where: { userId: actor.userId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 21,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      review: { select: { draft: true, revision: true } },
      message: {
        select: {
          observation: {
            select: { sourceRevision: true, acknowledgedRevision: true },
          },
        },
      },
      questions: { where: { status: "open" }, take: 1 },
    },
  });
  const polls = await db.ingestionPoll.findMany({
    where: { userId: actor.userId },
    take: 20,
    select: {
      connectionId: true,
      status: true,
      failures: true,
      nextRunAt: true,
    },
  });
  return AutomationActivitySchema.parse({
    items: rows.slice(0, 20).map((row) => {
      const draft = row.review?.draft as unknown as EventDraft | undefined;
      let reason = AutomationReasonSchema.safeParse(row.reason).success
        ? (row.reason as keyof typeof AUTOMATION_REASON_LABELS)
        : "action_failed";
      const q = row.questions[0];
      const current =
        q &&
        q.reviewRevision === row.review?.revision &&
        q.policyRevision === policy.revision &&
        q.sourceRevision === (row.message.observation?.sourceRevision || 1);
      if (q && !current) reason = "stale";
      const sourceNotice =
        row.message.observation &&
        row.message.observation.sourceRevision >
          row.message.observation.acknowledgedRevision;
      if (sourceNotice) reason = "source_changed";
      const proof = row.evidence as {
        approvalMode?: unknown;
        category?: unknown;
        provider?: unknown;
        duplicateCoverage?: { local?: unknown; google?: unknown };
        conflictCoverage?: { local?: unknown; google?: unknown };
      };
      const category = EventCategorySchema.safeParse(proof.category);
      const provider =
        proof.provider === "gmail"
          ? "Gmail"
          : proof.provider === "outlook"
            ? "Outlook"
            : proof.provider === "discord"
              ? "Discord"
              : null;
      const qualification =
        reason === "added" &&
        category.success &&
        provider &&
        proof.duplicateCoverage?.local === "checked" &&
        proof.duplicateCoverage.google === "checked" &&
        proof.conflictCoverage?.local === "checked" &&
        proof.conflictCoverage.google === "checked";
      const explanation = qualification
        ? `${proof.approvalMode === "user_confirmed" ? "Added after your one-time confirmation for" : "Added because the rule active at that time allowed"} ${EVENT_CATEGORY_LABELS[category.data]} from ${provider}; required facts were explicit or confirmed by you, and duplicate and conflict checks completed.${row.duplicateFingerprint ? " You confirmed the possible match as a separate commitment." : ""}${row.conflictFingerprint ? " You confirmed the scheduling conflict." : ""}`
        : AUTOMATION_REASON_LABELS[reason];
      const temporal = draft?.temporal;
      const suggestedTemporal =
        temporal?.kind === "unresolved"
          ? {
              kind: "unresolved",
              text: "",
              timezone: temporal.timezone,
              timezoneProvenance: temporal.timezoneProvenance,
              partial: temporal.partial,
            }
          : temporal;
      return {
        id: row.id,
        reviewId: row.reviewId,
        title: draft?.title || "Imported announcement",
        decision: sourceNotice
          ? "ask_user"
          : reason === "stale"
            ? "blocked"
            : row.decision,
        reason,
        explanation,
        createdAt: row.updatedAt.toISOString(),
        question: current
          ? {
              id: q.id,
              kind: QuestionKindSchema.parse(q.kind),
              reviewRevision: q.reviewRevision,
              prompt: AUTOMATION_REASON_LABELS[reason],
              ...(q.kind === "facts" &&
              q.advisoryFingerprint === "reason:source_untrusted"
                ? { oneTimeApproval: true }
                : {}),
              ...(["duplicate", "conflict"].includes(q.kind)
                ? {
                    matches:
                      (row.evidence as { advisories?: unknown[] }).advisories ||
                      [],
                  }
                : {}),
              ...(suggestedTemporal ? { suggestedTemporal } : {}),
            }
          : null,
      };
    }),
    polls: polls.map((p) => ({ ...p, nextRunAt: p.nextRunAt.toISOString() })),
    nextCursor: rows.length > 20 ? rows[19].id : null,
  });
}
