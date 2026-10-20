import {
  AutomationReasonSchema,
  type AutomationReason,
} from "./automationReasons.js";
export {
  AutomationReasonSchema,
  AUTOMATION_REASON_LABELS,
  type AutomationReason,
} from "./automationReasons.js";
import { z } from "zod";
import { EventCategorySchema } from "./categories.js";
import { EditableEventDraftSchema, type EventDraft } from "./events.js";
import { evaluateDraft, isUsableTitle } from "./readiness.js";
import type { ReviewDetail } from "./reviews.js";
import type { DuplicateCheck } from "./duplicates.js";
export const PolicyRuleSchema = z
  .object({
    connectionId: z.uuid(),
    channelId: z
      .string()
      .regex(/^\d{17,20}$/)
      .optional(),
    category: EventCategorySchema,
    action: z.enum(["auto", "ask", "skip"]),
  })
  .strict();
export const AutomationPolicyInputSchema = z
  .object({
    enabled: z.boolean(),
    pollGmail: z.boolean(),
    rules: z.array(PolicyRuleSchema).max(100),
  })
  .strict();
export type AutomationPolicyInput = z.infer<typeof AutomationPolicyInputSchema>;
export const AutomationPolicySchema = AutomationPolicyInputSchema.extend({
  revision: z.number().int().positive(),
  enabledAt: z.string().nullable(),
  liveWritesEnabled: z.boolean(),
});
export const QuestionKindSchema = z.enum([
  "title",
  "date",
  "time",
  "all_day",
  "timezone",
  "facts",
  "duplicate",
  "conflict",
  "source",
  "category",
]);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;
export const QuestionAnswerSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("category"), value: EventCategorySchema })
    .strict(),
  z
    .object({
      kind: z.literal("title"),
      value: z.string().trim().min(1).max(300),
    })
    .strict(),
  z.object({ kind: z.literal("date"), value: z.iso.date() }).strict(),
  z
    .object({
      kind: z.literal("temporal"),
      value: EditableEventDraftSchema.shape.temporal,
    })
    .strict(),
  z.object({ kind: z.literal("all_day"), value: z.literal(true) }).strict(),
  z.object({ kind: z.literal("confirm"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("skip") }).strict(),
]);
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export const AutomationDecisionSchema = z
  .object({
    decision: z.enum(["auto_handle", "ask_user", "skip", "blocked"]),
    reason: AutomationReasonSchema,
    question: QuestionKindSchema.optional(),
  })
  .strict();
export type ActionDecision = z.infer<typeof AutomationDecisionSchema>;
export interface AutomationContext {
  policy: AutomationPolicyInput;
  review: ReviewDetail;
  source: {
    connectionId: string;
    channelId?: string;
    connected: boolean;
    eligible: boolean;
  };
  checks?: DuplicateCheck;
  confirmedFields?: string[];
  duplicateAccepted?: boolean;
  conflictAccepted?: boolean;
}
export function applicableAutomationRule(
  policy: AutomationPolicyInput,
  source: AutomationContext["source"],
  category: EventDraft["eventCategory"],
) {
  const priority = { skip: 0, ask: 1, auto: 2 };
  return (
    policy.rules
      .filter(
        (rule) =>
          rule.connectionId === source.connectionId &&
          rule.category === (category || "other") &&
          (!rule.channelId || rule.channelId === source.channelId),
      )
      .sort((a, b) => priority[a.action] - priority[b.action])[0] || null
  );
}
export function evaluateAutomation(c: AutomationContext): ActionDecision {
  const result = (
    decision: ActionDecision["decision"],
    reason: AutomationReason,
    question?: QuestionKind,
  ): ActionDecision => ({
    decision,
    reason,
    ...(question ? { question } : {}),
  });
  const ask = (reason: AutomationReason, question: QuestionKind) =>
    result("ask_user", reason, question);
  const r = c.review,
    d = r.draft;
  if (r.status === "ignored") return result("skip", "user_ignored");
  if (r.status === "added") return result("skip", "already_added");
  if (!c.policy.enabled) return result("blocked", "automation_disabled");
  if (!c.source.eligible) return result("blocked", "historical");
  if (!c.source.connected) return result("blocked", "source_unavailable");
  if (r.source?.notice?.requiresConfirmation)
    return ask("source_changed", "source");
  if (!["needs_review", "approved", "writing"].includes(r.status))
    return result("blocked", "manual_state");
  const rule = applicableAutomationRule(c.policy, c.source, d.eventCategory);
  if (rule?.action === "skip") return result("skip", "category_skipped");
  if (!isUsableTitle(d.title)) return ask("title_required", "title");
  const t = d.temporal;
  if (t.kind === "unresolved")
    return ask(
      t.partial?.year && t.partial?.month && t.partial?.day
        ? "time_required"
        : "date_required",
      t.partial?.year && t.partial?.month && t.partial?.day ? "time" : "date",
    );
  if (t.kind === "date_only") return ask("all_day_confirmation", "all_day");
  if (evaluateDraft(d).status !== "ready") return ask("time_required", "time");
  const confirmed = new Set(c.confirmedFields || []);
  if (
    r.source?.contentStatus === "expired_or_deleted" &&
    (!confirmed.has("title") || !confirmed.has("temporal"))
  )
    return ask("facts_confirmation", "facts");
  if (
    r.candidate.classification?.status !== "classified" &&
    !confirmed.has("category")
  )
    return ask("category_ambiguous", "category");
  if (!confirmed.has("temporal")) {
    if (t.kind === "all_day") return ask("facts_confirmation", "facts");
    if (t.timezoneProvenance !== "explicit")
      return ask("timezone_confirmation", "timezone");
    const codes = new Set(r.candidate.evidence.map((x) => x.code));
    if (
      !codes.has("explicit_date") ||
      !codes.has("explicit_time") ||
      r.candidate.validationIssues.length ||
      JSON.stringify(t) !== JSON.stringify(r.candidate.draft.temporal)
    )
      return ask("facts_confirmation", "facts");
  }
  if (d.title !== r.candidate.draft.title && !confirmed.has("title"))
    return ask("facts_confirmation", "facts");
  const check = c.checks;
  if (
    !check ||
    check.local.status !== "checked" ||
    check.google.status !== "checked" ||
    check.truncated ||
    !check.conflicts ||
    check.conflicts.local.status !== "checked" ||
    check.conflicts.google.status !== "checked" ||
    check.conflicts.truncated
  )
    return result("blocked", "checks_unavailable");
  if (check.matches.some((x) => x.strength === "exact_identity"))
    return result("blocked", "protected_identity");
  if (check.matches.length && !c.duplicateAccepted)
    return ask("possible_duplicate", "duplicate");
  if (check.conflicts.matches.length && !c.conflictAccepted)
    return ask("scheduling_conflict", "conflict");
  if (rule?.action !== "auto" && !confirmed.has("permission"))
    return ask("source_untrusted", "facts");
  return result(
    "auto_handle",
    confirmed.has("permission") ? "user_authorized" : "eligible",
  );
}
export const AutomationQuestionSchema = z.object({
  id: z.uuid(),
  kind: QuestionKindSchema,
  reviewRevision: z.number().int().positive(),
  prompt: z.string(),
  oneTimeApproval: z.boolean().optional(),
  suggestedTemporal: EditableEventDraftSchema.shape.temporal.optional(),
  matches: z
    .array(
      z.object({
        title: z.string().max(300),
        temporal: EditableEventDraftSchema.shape.temporal.nullable(),
      }),
    )
    .max(5)
    .optional(),
});
export const AutomationActivitySchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      reviewId: z.uuid().nullable(),
      title: z.string(),
      decision: AutomationDecisionSchema.shape.decision,
      reason: AutomationReasonSchema,
      explanation: z.string(),
      createdAt: z.string(),
      question: AutomationQuestionSchema.nullable(),
    }),
  ),
  polls: z.array(
    z.object({
      connectionId: z.uuid(),
      status: z.enum(["ready", "retry", "blocked"]),
      failures: z.number().int(),
      nextRunAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const AutomationSourcesSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.uuid(),
        provider: z.enum(["gmail", "outlook", "discord"]),
        status: z.string().max(80),
        channelIds: z.array(z.string()).max(10),
      }),
    )
    .max(30),
});
