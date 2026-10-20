import {
  EditableEventDraftSchema,
  ReadyEventSchema,
  validateTemporalReadiness,
  type ReadyEvent,
} from "./events.js";
import type { TemporalIssue } from "./temporal.js";
import type { CalendarWriteOutcome, ReviewDetail } from "./reviews.js";
import { writeRecovery, type Recovery } from "./processing.js";
export interface Blocker extends TemporalIssue {
  kind: "missing" | "unresolved" | "invalid" | "confirmation_required";
}
export interface DraftEvaluation {
  status: "ready" | "blocked";
  blockers: Blocker[];
  missingFields: string[];
  event?: ReadyEvent;
}
const placeholders = new Set([
  "no subject",
  "(no subject)",
  "event needing review",
  "untitled candidate",
  "untitled message",
]);
export function isUsableTitle(title: unknown, legacy = false): boolean {
  return (
    typeof title === "string" &&
    !!title.trim() &&
    (legacy || !placeholders.has(title.trim().toLowerCase()))
  );
}
const explanations: Record<string, string> = {
  duration_confirmation_required:
    "Confirm the proposed duration before approval.",
  title_required: "Enter an event title before approval.",
  date_only_unconfirmed:
    "Confirm an all-day event or supply a specific time before approval.",
  end_required: "End time is required before approval.",
  year_required: "Choose a year for this date before approval.",
  date_required: "Enter a complete date before approval.",
  start_required: "Supply a specific start time or confirm an all-day event.",
  unresolved_time: "Correct the unresolved date and time before approval.",
  invalid_interval: "End must follow start.",
  unresolved_timezone: "Correct the unsupported or ambiguous timezone.",
  conflicting_zones: "Correct the conflicting timezone evidence.",
  conflicting_times: "Correct the conflicting time evidence.",
  multiple_dates: "Confirm a single event date from the conflicting evidence.",
  ambiguous_commitment: "Correct the ambiguous or updated commitment.",
  nonexistent_time:
    "This local time does not exist in this timezone. Correct it.",
  repeated_time: "Choose which occurrence of this local time you mean.",
  invalid_date: "Enter a valid complete calendar date.",
  invalid_local_time: "Enter a valid local date/time and IANA timezone.",
  invalid_field: "Check this field and its supported format.",
};
export function evaluateDraft(
  input: unknown,
  options: { legacyTitle?: boolean; conversionIssues?: TemporalIssue[] } = {},
): DraftEvaluation {
  const blockers: Blocker[] = [];
  const add = (field: string, code: string, kind: Blocker["kind"]) => {
    if (!blockers.some((b) => b.field === field && b.code === code))
      blockers.push({
        field,
        code,
        kind,
        message: Object.hasOwn(explanations, code)
          ? explanations[code]
          : explanations.invalid_field,
      });
  };
  const obj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  if (!isUsableTitle(obj.title, options.legacyTitle))
    add("title", "title_required", "missing");
  const draft = EditableEventDraftSchema.safeParse(input);
  if (!draft.success)
    for (const issue of draft.error.issues) {
      const field = issue.path.join(".") || "draft";
      if (field === "title" && !isUsableTitle(obj.title, options.legacyTitle))
        continue;
      add(field, "invalid_field", "invalid");
    }
  const temporal = validateTemporalReadiness(obj.temporal);
  if (!temporal.ok) {
    const t = draft.success ? draft.data.temporal : null;
    if (t?.kind === "unresolved") {
      let detail = false;
      if (t.partial?.month && t.partial.day && !t.partial.year) {
        add("temporal.year", "year_required", "missing");
        detail = true;
      }
      for (const code of t.issueCodes || [])
        if (Object.hasOwn(explanations, code)) {
          add("temporal", code, "unresolved");
          detail = true;
        }
      if (!t.partial?.startClock) {
        add("temporal.start", "start_required", "missing");
        detail = true;
      }
      if (!detail) add("temporal", "unresolved_time", "unresolved");
    } else
      for (const issue of temporal.issues)
        add(
          issue.field,
          issue.code,
          issue.code === "end_required"
            ? "missing"
            : issue.code === "date_only_unconfirmed"
              ? "confirmation_required"
              : "invalid",
        );
  }
  for (const issue of options.conversionIssues || [])
    add(
      issue.field,
      Object.hasOwn(explanations, issue.code) ? issue.code : "invalid_field",
      ["repeated_time", "duration_confirmation_required"].includes(issue.code)
        ? "confirmation_required"
        : "invalid",
    );
  const missingFields = [
    ...new Set(
      blockers.filter((b) => b.kind === "missing").map((b) => b.field),
    ),
  ];
  if (blockers.length) return { status: "blocked", blockers, missingFields };
  const ready = ReadyEventSchema.safeParse(input);
  if (!ready.success)
    return {
      status: "blocked",
      blockers: [
        {
          field: "draft",
          code: "invalid_field",
          kind: "invalid",
          message: explanations.invalid_field,
        },
      ],
      missingFields: [],
    };
  return {
    status: "ready",
    blockers: [],
    missingFields: [],
    event: ready.data,
  };
}
export interface ReviewState {
  workflow: { phase: "review" | "approved" | "ignored" };
  readiness: Omit<DraftEvaluation, "event">;
  actions: {
    edit: boolean;
    ignore: boolean;
    approve: boolean;
    write: boolean;
    refresh: boolean;
  };
  recovery: Recovery;
}
export function deriveReviewState(
  status: ReviewDetail["status"],
  evaluation: DraftEvaluation,
  write: CalendarWriteOutcome | null,
  options: { leaseActive?: boolean; integrityValid?: boolean } = {},
): ReviewState {
  const phase =
    status === "needs_review"
      ? "review"
      : status === "ignored"
        ? "ignored"
        : "approved";
  const integrity = options.integrityValid !== false;
  const recovery =
    phase === "approved"
      ? writeRecovery(
          write?.status || "pending",
          write?.reason,
          options.leaseActive ?? write?.status === "writing",
        )
      : phase === "review" && evaluation.blockers.length
        ? {
            action: "correct" as const,
            canRetryNow: false,
            message: "Correct the required event details before approval.",
          }
        : {
            action: "none" as const,
            canRetryNow: false,
            message:
              phase === "ignored"
                ? "This candidate remains ignored."
                : "Review the extracted commitment before approving it.",
          };
  return {
    workflow: { phase },
    readiness: {
      status: evaluation.status,
      blockers: evaluation.blockers,
      missingFields: evaluation.missingFields,
    },
    actions: {
      edit: integrity && phase === "review",
      ignore: integrity && phase === "review",
      approve: integrity && phase === "review" && evaluation.status === "ready",
      write:
        integrity &&
        phase === "approved" &&
        evaluation.status === "ready" &&
        recovery.canRetryNow,
      refresh: phase === "approved",
    },
    recovery: integrity
      ? recovery
      : {
          action: "resolve_issue",
          canRetryNow: false,
          message: "The saved record could not be interpreted safely.",
        },
  };
}

export function hasReviewIntegrity(
  status: ReviewDetail["status"],
  approved: boolean,
  write: CalendarWriteOutcome | null,
): boolean {
  if (status === "needs_review" || status === "ignored")
    return !approved && !write;
  if (!approved) return false;
  if (status === "added") return write?.status === "added" && !!write.receipt;
  if (status === "writing") return write?.status === "writing";
  return !write || write.status === "failed" || write.status === "unknown";
}
