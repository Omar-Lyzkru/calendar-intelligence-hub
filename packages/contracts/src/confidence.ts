import { z } from "zod";
import type { EditableEventDraft, Evidence } from "./events.js";
import { validateTemporalReadiness } from "./events.js";
import type { Classification } from "./categories.js";
export const CONFIDENCE_WEIGHTS = {
  explicit_date: 2,
  explicit_time: 1,
  explicit_timezone: 1,
  event_wording: 1,
  complete_temporal: 2,
  corroborated_temporal: 1,
  unresolved_temporal: -3,
  conflicting_evidence: -3,
  assumed_timezone: -1,
  weak_wording: -1,
  ambiguous_category: -1,
} as const;
export type ConfidenceSignal = keyof typeof CONFIDENCE_WEIGHTS;
export const CONFIDENCE_SIGNAL_LABELS: Record<ConfidenceSignal, string> = {
  explicit_date: "A complete date was stated in the source.",
  explicit_time: "A time was stated in the source.",
  explicit_timezone: "The source supplied a resolved timezone.",
  event_wording: "Supported event wording was found.",
  complete_temporal: "The extracted interval is temporally complete and valid.",
  corroborated_temporal:
    "The same date or time wording appears in subject and body.",
  unresolved_temporal: "The original date or time needs interpretation.",
  conflicting_evidence: "The source contains conflicting temporal evidence.",
  assumed_timezone: "The timezone was assumed from settings.",
  weak_wording: "No supported event wording was recorded.",
  ambiguous_category: "More than one category was suggested.",
};
const SignalSchema = z.enum(
  Object.keys(CONFIDENCE_WEIGHTS) as [ConfidenceSignal, ...ConfidenceSignal[]],
);
const HIGH_SUPPORT = 6,
  MEDIUM_SUPPORT = 3;
function bandFor(points: number): "low" | "medium" | "high" {
  return points >= HIGH_SUPPORT
    ? "high"
    : points >= MEDIUM_SUPPORT
      ? "medium"
      : "low";
}
export const ConfidenceReportSchema = z
  .object({
    version: z.literal(1),
    basis: z.literal("original_extraction"),
    band: z.enum(["low", "medium", "high"]),
    signals: z
      .array(
        z.object({ code: SignalSchema, points: z.number().int() }).strict(),
      )
      .max(11),
  })
  .strict()
  .refine((r) => {
    return (
      new Set(r.signals.map((s) => s.code)).size === r.signals.length &&
      r.signals.every((s) => s.points === CONFIDENCE_WEIGHTS[s.code]) &&
      r.band === bandFor(r.signals.reduce((n, s) => n + s.points, 0))
    );
  }, "Confidence signals and band must agree.");
export type ConfidenceReport = z.infer<typeof ConfidenceReportSchema>;
export function evaluateConfidence(input: {
  draft: EditableEventDraft;
  evidence: Evidence[];
  classification?: Classification;
}): ConfidenceReport {
  const { draft, evidence, classification } = input;
  const codes = new Set(evidence.map((e) => e.code));
  const signals: ConfidenceReport["signals"] = [];
  const add = (code: ConfidenceSignal) =>
    signals.push({ code, points: CONFIDENCE_WEIGHTS[code] });
  if (codes.has("explicit_date")) add("explicit_date");
  if (codes.has("explicit_time")) add("explicit_time");
  const temporal = draft.temporal;
  if (
    (temporal.kind === "timed" || temporal.kind === "unresolved") &&
    temporal.timezoneProvenance === "explicit"
  )
    add("explicit_timezone");
  const wording =
    codes.has("event_keyword") ||
    evidence.some((e) => e.code.startsWith("category_keyword_"));
  if (wording) add("event_wording");
  if (validateTemporalReadiness(temporal).ok) add("complete_temporal");
  const issues =
    temporal.kind === "unresolved" ? temporal.issueCodes || [] : [];
  const conflicting =
    codes.has("conflicting_zones") ||
    issues.some(
      (c) =>
        c.startsWith("conflicting_") ||
        [
          "multiple_dates",
          "multiple_times",
          "offset_mismatch",
          "weekday_mismatch",
          "ambiguous_interval",
        ].includes(c),
    );
  const normalized = (text: string) =>
    text.trim().toLowerCase().replace(/\s+/g, " ");
  if (
    !conflicting &&
    !issues.includes("unresolved_timezone") &&
    ["explicit_date", "explicit_time"].some((code) => {
      const subjects = new Set(
        evidence
          .filter((e) => e.code === code && e.origin === "subject" && e.text)
          .map((e) => normalized(e.text!)),
      );
      return evidence.some(
        (e) =>
          e.code === code &&
          e.origin === "content" &&
          e.text &&
          subjects.has(normalized(e.text)),
      );
    })
  )
    add("corroborated_temporal");
  if (temporal.kind === "unresolved") add("unresolved_temporal");
  if (conflicting) add("conflicting_evidence");
  if (
    (temporal.kind === "timed" || temporal.kind === "unresolved") &&
    temporal.timezoneProvenance === "assumed"
  )
    add("assumed_timezone");
  if (!wording) add("weak_wording");
  if (classification?.status === "ambiguous") add("ambiguous_category");
  return {
    version: 1,
    basis: "original_extraction",
    band: bandFor(signals.reduce((n, s) => n + s.points, 0)),
    signals,
  };
}
