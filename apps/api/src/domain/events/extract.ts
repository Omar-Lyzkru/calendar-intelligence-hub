import { Temporal } from "@js-temporal/polyfill";
import {
  chooseLocalTime,
  evaluateConfidence,
  isUsableTitle,
  PartialTemporalFactsSchema,
  type NormalizedMessage,
  type EventCandidate,
  type EventDraft,
  type TemporalIssue,
  type Evidence,
} from "@hub/contracts";
import { categorize } from "./categorize.js";
import { classify } from "./classify.js";
import { parseDates, type DateToken } from "./parseDates.js";
import { parseTimes } from "./parseTimes.js";
import { parseTimezones, corroboratingOffsets } from "./parseTimezones.js";
export function extract(
  message: NormalizedMessage,
  configuredZone: string,
): EventCandidate {
  const sources = [
    { origin: "subject" as const, text: message.subject || "" },
    { origin: "content" as const, text: message.content },
  ];
  const all = sources.map((s) => ({
    ...s,
    dates: parseDates(s.text, s.origin),
    times: parseTimes(s.text, s.origin),
    zone: parseTimezones(s.text, s.origin, configuredZone),
  }));
  const categorized = categorize(message);
  const evidence: Evidence[] = [
    ...classify(message).evidence,
    ...categorized.evidence,
  ];
  const issues: TemporalIssue[] = all.flatMap((s) => [
    ...s.dates.flatMap((d) => d.issues),
    ...s.times.issues,
    ...(s.zone.kind === "unresolved" ? s.zone.issues : []),
  ]);
  const rawDates = all.flatMap((s) => s.dates);
  const dates = [
    ...new Map(
      rawDates.map((d) => [d.completeDate || JSON.stringify(d.partial), d]),
    ).values(),
  ];
  const timeSets = all
    .filter((s) => s.times.tokens.length)
    .map((s) => s.times.tokens.map((t) => t.clock));
  const clocks = [...timeSets].sort((a, b) => b.length - a.length)[0] || [];
  if (
    timeSets.some((set) => set.some((clock, index) => clock !== clocks[index]))
  )
    issues.push({
      field: "time",
      code: "conflicting_times",
      message: "Conflicting times require correction.",
    });
  for (const source of all) {
    const tokens = source.times.tokens;
    if (tokens.length !== 2) continue;
    let between = source.text.slice(tokens[0].end, tokens[1].start);
    for (const fact of [...source.dates, ...source.zone.evidence]
      .filter((f) => f.start !== undefined && f.end !== undefined)
      .sort((a, b) => b.start! - a.start!)) {
      if (fact.start! >= tokens[0].end && fact.end! <= tokens[1].start) {
        const start = fact.start! - tokens[0].end,
          end = fact.end! - tokens[0].end;
        between =
          between.slice(0, start) +
          " ".repeat(end - start) +
          between.slice(end);
      }
    }
    if (!/^\s*(?:to|until|through|[-–])\s*(?:at\s*)?$/i.test(between))
      issues.push({
        field: "time",
        code: "ambiguous_interval",
        message:
          "Supply a clear start and end interval; alternatives are unresolved.",
      });
  }
  const zones = all
    .filter(
      (s) => s.zone.kind === "resolved" && s.zone.provenance === "explicit",
    )
    .map((s) => (s.zone.kind === "resolved" ? s.zone.timezone : ""));
  if (new Set(zones).size > 1)
    issues.push({
      field: "timezone",
      code: "conflicting_zones",
      message: "Conflicting timezones require correction.",
    });
  const timezone = zones[0] || configuredZone,
    provenance = zones.length ? ("explicit" as const) : ("assumed" as const);
  const combined = sources.map((s) => s.text).join("\n");
  if (
    /\b(cancelled|canceled|cancel|cancellation|moved|rescheduled|postponed|updated|changed|every|recurring|repeats|weekly|daily|monthly|yearly|annually|biweekly|fortnightly|next|usual|today|tomorrow|yesterday|tonight|soon|later|morning|afternoon|evening|this (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|week|month|year)|in \d+ (?:hours?|days?|weeks?|months?)|after class|after the lecture|one week later)\b/i.test(
      combined,
    )
  )
    issues.push({
      field: "temporal",
      code: "ambiguous_commitment",
      message:
        "Ambiguous or updated commitment: author a single event explicitly",
    });
  for (const s of all) {
    evidence.push(...s.zone.evidence);
    for (const d of s.dates)
      evidence.push({
        code: d.completeDate ? "explicit_date" : "partial_date",
        origin: d.origin,
        text: d.text,
        start: d.start,
        end: d.end,
      });
    for (const t of s.times.tokens)
      evidence.push({
        code: "explicit_time",
        origin: t.origin,
        text: t.text,
        start: t.start,
        end: t.end,
      });
  }
  const rangeSource = all.find(
    (s) =>
      s.dates.length === 2 &&
      (() => {
        const between = s.text.slice(s.dates[0].end, s.dates[1].start);
        return /^\s*(?:(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\s*)?(?:to|through|until|[-–])\s*$/i.test(
          between,
        );
      })(),
  );
  const isRange =
    dates.length === 2 &&
    rangeSource &&
    dates.every((d) => d.completeDate) &&
    rangeSource.dates.every((d) =>
      dates.some((x) => x.completeDate === d.completeDate),
    );
  if (dates.length > 1 && !isRange)
    issues.push({
      field: "date",
      code: "multiple_dates",
      message: "Multiple commitments require a manually authored single event.",
    });
  if (clocks.length > 2)
    issues.push({
      field: "time",
      code: "multiple_times",
      message: "Multiple commitments require correction.",
    });
  let temporal: EventDraft["temporal"] = {
    kind: "unresolved",
    text: message.content.slice(0, 2000),
    timezone,
    timezoneProvenance: provenance,
  };
  const partial = dates[0]?.partial;
  const safe = PartialTemporalFactsSchema.safeParse({
    ...partial,
    ...(clocks[0] ? { startClock: clocks[0] } : {}),
    ...(clocks[1] ? { endClock: clocks[1] } : {}),
  });
  if (safe.success) temporal.partial = safe.data;
  if (!issues.length && dates.length && dates.every((d) => d.completeDate)) {
    const startDate = dates[0].completeDate!,
      endDate = dates[dates.length - 1].completeDate!;
    if (!clocks.length) {
      if (endDate < startDate)
        issues.push({
          field: "date",
          code: "invalid_range",
          message: "End date must not precede start date.",
        });
      else
        temporal = {
          kind: "date_only",
          startDate,
          endDateInclusive: dates.length === 2 ? endDate : null,
        };
    } else {
      const selected = (date: string, clock: string) => {
        const local = date + "T" + clock;
        let choice: "reject" | "earlier" | "later" = "reject";
        const abbreviations = all
          .flatMap((s) => s.zone.evidence)
          .filter((e) => e.code === "timezone_abbreviation")
          .map((e) => e.text!.toUpperCase());
        const desired = [
          ...new Set(
            abbreviations
              .map((a) => corroboratingOffsets[a]?.offset)
              .filter(Boolean),
          ),
        ];
        if (desired.length) {
          if (desired.length !== 1)
            return {
              ok: false as const,
              issues: [
                {
                  field: "timezone",
                  code: "offset_mismatch",
                  message: "Correct contradictory timezone evidence.",
                },
              ],
            };
          const early = Temporal.PlainDateTime.from(local).toZonedDateTime(
              timezone,
              { disambiguation: "earlier" },
            ),
            late = Temporal.PlainDateTime.from(local).toZonedDateTime(
              timezone,
              { disambiguation: "later" },
            );
          if (early.offset === desired[0]) choice = "earlier";
          else if (late.offset === desired[0]) choice = "later";
          else
            return {
              ok: false as const,
              issues: [
                {
                  field: "timezone",
                  code: "offset_mismatch",
                  message:
                    "The timezone abbreviation does not match this date.",
                },
              ],
            };
        }
        return chooseLocalTime(local, timezone, choice);
      };
      if (
        dates.length === 2 &&
        (!isRange ||
          Temporal.PlainDate.from(endDate).since(
            Temporal.PlainDate.from(startDate),
          ).days !== 1 ||
          clocks.length !== 2)
      )
        issues.push({
          field: "date",
          code: "ambiguous_range",
          message: "Correct the event date/time range.",
        });
      if (!issues.length) {
        const start = selected(startDate, clocks[0]),
          end = clocks[1] ? selected(endDate, clocks[1]) : null;
        if (!start.ok) issues.push(...start.issues);
        if (end && !end.ok) issues.push(...end.issues);
        if (start.ok && (!end || end.ok)) {
          if (
            end?.ok &&
            Temporal.Instant.compare(end.instant, start.instant) <= 0
          )
            issues.push({
              field: "end",
              code: "invalid_interval",
              message: "End must follow start; no overnight date is assumed.",
            });
          else
            temporal = {
              kind: "timed",
              start: start.instant,
              end: end?.ok ? end.instant : null,
              timezone,
              timezoneProvenance: provenance,
            };
        }
      }
    }
  }
  if (issues.length)
    temporal = {
      kind: "unresolved",
      text: message.content.slice(0, 2000),
      timezone,
      timezoneProvenance: provenance,
      ...(safe.success ? { partial: safe.data } : {}),
      issueCodes: [...new Set(issues.map((i) => i.code))],
    };
  const draft: EventDraft = {
    title: (isUsableTitle(message.subject)
      ? message.subject!.trim()
      : ""
    ).slice(0, 300),
    location: null,
    description: null,
    category: /\b(due|deadline|assignment)\b/i.test(combined)
      ? "deadline"
      : "event",
    eventCategory: categorized.classification.category,
    temporal,
  };
  const missingFields: string[] = [];
  if (!dates.length || dates.some((d) => !d.completeDate))
    missingFields.push("date");
  if (!clocks.length) missingFields.push("start");
  if (temporal.kind === "timed" && !temporal.end) missingFields.push("end");
  if (temporal.kind === "unresolved" && !missingFields.length)
    missingFields.push("temporal");
  return {
    draft,
    missingFields,
    validationIssues: [...new Set(issues.map((i) => i.message))],
    evidence,
    extractionVersion: 2,
    confidence: evaluateConfidence({
      draft,
      evidence,
      classification: categorized.classification,
    }),
    classification: categorized.classification,
  };
}
