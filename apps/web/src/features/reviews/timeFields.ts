import { Temporal } from "@js-temporal/polyfill";
import {
  chooseLocalTime,
  resolveLocalTime,
  canonicalCalendarDate,
  type EventDraft,
  type TemporalIssue,
  type TimezoneProvenance,
  type PartialTemporalFacts,
} from "@hub/contracts";
export interface TimeFields {
  kind: "timed" | "all_day" | "date_only";
  start: string;
  end: string;
  timezone: string;
  offset: "reject" | "earlier" | "later";
  endOffset?: "reject" | "earlier" | "later";
  timezoneProvenance?: TimezoneProvenance;
  knownStartDate?: string;
  knownEndDate?: string;
  unresolvedText?: string;
  unresolvedIssueCodes?: string[];
  partial?: PartialTemporalFacts;
}
export function initialTime(
  draft: EventDraft,
  configuredZone = "America/Chicago",
): TimeFields {
  const t = draft.temporal;
  const common = {
    timezone: "timezone" in t ? t.timezone : configuredZone,
    offset: "reject" as const,
  };
  if (t.kind === "all_day")
    return {
      ...common,
      kind: "all_day",
      start: t.startDate,
      end: t.endExclusive,
    };
  if (t.kind === "date_only")
    return {
      ...common,
      kind: "date_only",
      start: t.startDate,
      end: t.endDateInclusive || "",
    };
  if (t.kind === "unresolved") {
    const date =
      t.partial?.year && t.partial.month && t.partial.day
        ? `${String(t.partial.year).padStart(4, "0")}-${String(t.partial.month).padStart(2, "0")}-${String(t.partial.day).padStart(2, "0")}`
        : undefined;
    const end = t.partial?.endInstant
      ? Temporal.Instant.from(t.partial.endInstant)
          .toZonedDateTimeISO(t.timezone)
          .toPlainDateTime()
      : undefined;
    const localEnd =
      end?.toString({
        smallestUnit: end.second || end.millisecond ? "millisecond" : "minute",
      }) || "";
    const resolution = resolveLocalTime(localEnd, t.timezone);
    return {
      ...common,
      kind: "timed",
      start: "",
      end: localEnd,
      endOffset:
        resolution.kind === "repeated" && t.partial?.endInstant
          ? Temporal.Instant.compare(
              t.partial.endInstant,
              resolution.earlier,
            ) === 0
            ? "earlier"
            : "later"
          : "reject",
      timezoneProvenance: t.timezoneProvenance,
      unresolvedText: t.text,
      unresolvedIssueCodes: t.issueCodes,
      partial: t.partial,
      ...(date && canonicalCalendarDate(date).ok
        ? {
            knownStartDate: date,
            knownEndDate: t.partial?.endDateInclusive || date,
          }
        : {}),
    };
  }
  const local = (instant: string) => {
    const value = Temporal.Instant.from(instant)
      .toZonedDateTimeISO(t.timezone)
      .toPlainDateTime();
    return value.toString({
      smallestUnit:
        value.second || value.millisecond ? "millisecond" : "minute",
    });
  };
  const occurrence = (wall: string, instant: string): TimeFields["offset"] => {
    const r = resolveLocalTime(wall, t.timezone);
    return r.kind === "repeated"
      ? Temporal.Instant.compare(instant, r.earlier) === 0
        ? "earlier"
        : "later"
      : "reject";
  };
  const start = local(t.start),
    end = t.end ? local(t.end) : "";
  return {
    ...common,
    kind: "timed",
    start,
    end,
    offset: occurrence(start, t.start),
    endOffset: t.end ? occurrence(end, t.end) : "reject",
    timezoneProvenance: t.timezoneProvenance,
  };
}
export function interpretDateOnly(
  fields: TimeFields,
  kind: "all_day" | "timed",
): TimeFields {
  if (kind === "timed")
    return {
      ...fields,
      kind,
      start: "",
      end: "",
      knownStartDate: fields.start,
      knownEndDate: fields.end || fields.start,
    };
  return {
    ...fields,
    kind,
    start: fields.start,
    end: Temporal.PlainDate.from(fields.end || fields.start)
      .add({ days: 1 })
      .toString(),
  };
}
export function temporalFromFields(fields: TimeFields): EventDraft["temporal"] {
  if (fields.kind === "date_only")
    return {
      kind: "date_only",
      startDate: fields.start,
      endDateInclusive: fields.end || null,
    };
  if (fields.kind === "all_day") {
    if (
      !canonicalCalendarDate(fields.start).ok ||
      !canonicalCalendarDate(fields.end).ok
    )
      throw new TemporalInputError([
        {
          field: "temporal",
          code: "invalid_date",
          message: "Enter a valid start and exclusive end date.",
        },
      ]);
    return {
      kind: "all_day",
      startDate: fields.start,
      endExclusive: fields.end,
    };
  }
  const provenance = fields.timezoneProvenance
    ? { timezoneProvenance: fields.timezoneProvenance }
    : {};
  const instant = (
    local: string,
    offset: TimeFields["offset"],
    field = "temporal.start",
  ) => {
    const r = chooseLocalTime(local, fields.timezone, offset);
    if (!r.ok)
      throw new TemporalInputError(r.issues.map((i) => ({ ...i, field })));
    return r.instant;
  };
  if (!fields.start) {
    const partial = { ...fields.partial };
    if (
      fields.knownStartDate &&
      canonicalCalendarDate(fields.knownStartDate).ok
    ) {
      const date = Temporal.PlainDate.from(fields.knownStartDate);
      Object.assign(partial, {
        year: date.year,
        month: date.month,
        day: date.day,
      });
      if (fields.knownEndDate) partial.endDateInclusive = fields.knownEndDate;
    }
    if (fields.end)
      partial.endInstant = instant(
        fields.end,
        fields.endOffset || "reject",
        "temporal.end",
      );
    else delete partial.endInstant;
    return {
      kind: "unresolved",
      text: fields.unresolvedText || "",
      ...(fields.unresolvedIssueCodes
        ? { issueCodes: fields.unresolvedIssueCodes }
        : {}),
      timezone: fields.timezone,
      ...provenance,
      partial,
    };
  }
  return {
    kind: "timed",
    start: instant(fields.start, fields.offset),
    end: fields.end
      ? instant(fields.end, fields.endOffset || "reject", "temporal.end")
      : null,
    timezone: fields.timezone,
    ...provenance,
  };
}
export function proposedDuration(fields: TimeFields): {
  end: string;
  endOffset: TimeFields["offset"];
} {
  const start = chooseLocalTime(fields.start, fields.timezone, fields.offset);
  if (!start.ok) throw Error(start.issues[0]?.message);
  const end = Temporal.Instant.from(start.instant).add({ minutes: 60 });
  const local = end.toZonedDateTimeISO(fields.timezone).toPlainDateTime();
  const wall = local.toString({
    smallestUnit: local.second || local.millisecond ? "millisecond" : "minute",
  });
  const r = resolveLocalTime(wall, fields.timezone);
  return {
    end: wall,
    endOffset:
      r.kind === "repeated"
        ? Temporal.Instant.compare(end, r.earlier) === 0
          ? "earlier"
          : "later"
        : "reject",
  };
}

export class TemporalInputError extends Error {
  constructor(public issues: TemporalIssue[]) {
    super(issues.map((i) => i.message).join(" "));
  }
}
