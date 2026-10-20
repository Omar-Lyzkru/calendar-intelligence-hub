import type { ConfidenceReport } from "./confidence.js";
import { EventCategorySchema, type Classification } from "./categories.js";
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import {
  canonicalCalendarDate,
  canonicalInstant,
  type TemporalIssue,
} from "./temporal.js";
export const timezone = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "Invalid timezone");
const base = {
  title: z.string().trim().min(1).max(300),
  location: z.string().max(1000).nullable(),
  description: z.string().max(10000).nullable(),
  category: z.enum(["event", "deadline", "unknown"]),
  eventCategory: EventCategorySchema.optional(),
};
export const TimezoneProvenanceSchema = z.enum([
  "explicit",
  "assumed",
  "user_confirmed",
]);
export type TimezoneProvenance = z.infer<typeof TimezoneProvenanceSchema>;
export const PartialTemporalFactsSchema = z.object({
  year: z.number().int().min(1).max(9999).optional(),
  month: z.number().int().min(1).max(12).optional(),
  day: z.number().int().min(1).max(31).optional(),
  weekday: z.number().int().min(1).max(7).optional(),
  startClock: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  endClock: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  timezone: timezone.optional(),
  endDateInclusive: z.iso
    .date()
    .refine((v) => canonicalCalendarDate(v).ok)
    .optional(),
  endInstant: z.iso
    .datetime()
    .refine((v) => canonicalInstant(v).ok)
    .optional(),
  numericAlternatives: z
    .array(
      z.object({
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31),
      }),
    )
    .max(2)
    .optional(),
});
export type PartialTemporalFacts = z.infer<typeof PartialTemporalFactsSchema>;
const date = z.iso
  .date()
  .refine(
    (v) => canonicalCalendarDate(v).ok,
    "Enter a valid complete calendar date.",
  );
const instant = z.iso
  .datetime()
  .refine(
    (v) => canonicalInstant(v).ok,
    "Enter a valid UTC instant with millisecond precision.",
  );
export const TimedSchema = z.object({
  kind: z.literal("timed"),
  start: instant,
  end: instant.nullable(),
  timezone,
  timezoneProvenance: TimezoneProvenanceSchema.optional(),
});
export const AllDaySchema = z.object({
  kind: z.literal("all_day"),
  startDate: date,
  endExclusive: date,
});
export const DateOnlySchema = z
  .object({
    kind: z.literal("date_only"),
    startDate: date,
    endDateInclusive: date.nullable(),
  })
  .refine(
    (v) => !v.endDateInclusive || v.endDateInclusive >= v.startDate,
    "End date must not precede start date",
  );
export const UnresolvedSchema = z.object({
  kind: z.literal("unresolved"),
  text: z.string().max(2000),
  timezone,
  timezoneProvenance: TimezoneProvenanceSchema.optional(),
  partial: PartialTemporalFactsSchema.optional(),
  issueCodes: z.array(z.string().max(80)).max(30).optional(),
});
export const EventDraftSchema = z.object({
  ...base,
  temporal: z.discriminatedUnion("kind", [
    TimedSchema,
    AllDaySchema,
    DateOnlySchema,
    UnresolvedSchema,
  ]),
});
export const EditableEventDraftSchema = EventDraftSchema.extend({
  title: z.string().trim().max(300),
});
export type EditableEventDraft = z.infer<typeof EditableEventDraftSchema>;
export const ReadyEventSchema = z.object({
  ...base,
  temporal: z.union([
    TimedSchema.extend({ end: instant }).refine(
      (v) => Temporal.Instant.compare(v.end, v.start) > 0,
      "End must follow start",
    ),
    AllDaySchema.refine(
      (v) => v.endExclusive > v.startDate,
      "End must follow start",
    ),
  ]),
});
export function validateReadyEvent(
  input: unknown,
): { ok: true; event: ReadyEvent } | { ok: false; issues: TemporalIssue[] } {
  const draft = EventDraftSchema.safeParse(input);
  if (!draft.success)
    return {
      ok: false,
      issues: draft.error.issues.map((i) => ({
        field: i.path.join("."),
        code: "invalid_field",
        message: i.message,
      })),
    };
  const temporal = validateTemporalReadiness(draft.data.temporal);
  return temporal.ok
    ? { ok: true, event: ReadyEventSchema.parse(draft.data) }
    : temporal;
}
export function validateTemporalReadiness(
  input: unknown,
):
  | { ok: true; temporal: ReadyEvent["temporal"] }
  | { ok: false; issues: TemporalIssue[] } {
  const parsed = EventDraftSchema.shape.temporal.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        field: ["temporal", ...i.path].join("."),
        code: "invalid_field",
        message: i.message,
      })),
    };
  const t = parsed.data;
  if (t.kind === "date_only")
    return {
      ok: false,
      issues: [
        {
          field: "temporal",
          code: "date_only_unconfirmed",
          message:
            "Confirm an all-day event or supply a specific time before approval.",
        },
      ],
    };
  if (t.kind === "unresolved")
    return {
      ok: false,
      issues: [
        {
          field: "temporal",
          code: "unresolved_time",
          message:
            t.partial?.month && t.partial?.day && !t.partial.year
              ? "Choose a year for this date before approval."
              : "Correct the unresolved date and time before approval.",
        },
      ],
    };
  if (t.kind === "timed" && !t.end)
    return {
      ok: false,
      issues: [
        {
          field: "temporal.end",
          code: "end_required",
          message: "End time is required before approval.",
        },
      ],
    };
  const ready = ReadyEventSchema.shape.temporal.safeParse(t);
  return ready.success
    ? { ok: true, temporal: ready.data }
    : {
        ok: false,
        issues: ready.error.issues.map((i) => ({
          field: ["temporal", ...i.path].join("."),
          code: "invalid_interval",
          message: i.message,
        })),
      };
}
export type EventDraft = z.infer<typeof EventDraftSchema>;
export type ReadyEvent = z.infer<typeof ReadyEventSchema>;
export interface Evidence {
  code: string;
  text?: string;
  start?: number;
  end?: number;
  origin?: "subject" | "content";
}
export interface EventCandidate {
  draft: EditableEventDraft;
  missingFields: string[];
  validationIssues: string[];
  evidence: Evidence[];
  extractionVersion: number;
  confidence: ConfidenceReport | null;
  classification?: Classification;
}
export type ProcessingResult =
  | { kind: "no_event"; reasons: string[] }
  | { kind: "review"; candidate: EventCandidate };
export type ValidationResult =
  { ok: true; event: ReadyEvent } | { ok: false; issues: string[] };
