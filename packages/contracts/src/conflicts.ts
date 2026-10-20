import { Temporal } from "@js-temporal/polyfill";
import { ReadyEventSchema } from "./events.js";
import {
  compareDuplicate,
  type ConflictMatch,
  type DuplicateRecord,
} from "./duplicates.js";
export function conflictTemporalReady(
  temporal: DuplicateRecord["temporal"],
): boolean {
  return ReadyEventSchema.shape.temporal.safeParse(temporal).success;
}
function interval(
  record: DuplicateRecord,
  timezone: string,
): { start: string; end: string } | null {
  const parsed = ReadyEventSchema.shape.temporal.safeParse(record.temporal);
  if (!parsed.success) return null;
  const t = parsed.data;
  if (t.kind === "timed")
    return {
      start: Temporal.Instant.from(t.start).toString({
        fractionalSecondDigits: 3,
      }),
      end: Temporal.Instant.from(t.end).toString({ fractionalSecondDigits: 3 }),
    };
  const zone = record.source === "google" ? record.calendarTimezone : timezone;
  if (!zone) return null;
  try {
    const start = Temporal.PlainDate.from(t.startDate)
      .toZonedDateTime(zone)
      .toInstant()
      .toString({ fractionalSecondDigits: 3 });
    const end = Temporal.PlainDate.from(t.endExclusive)
      .toZonedDateTime(zone)
      .toInstant()
      .toString({ fractionalSecondDigits: 3 });
    return start < end ? { start, end } : null;
  } catch {
    return null;
  }
}
// Coalesce only confirmed IDs supplied by the persistence boundary. Live facts win.
export function collectConflicts(
  candidate: DuplicateRecord,
  records: DuplicateRecord[],
  timezone: string,
): {
  matches: ConflictMatch[];
  unsupported: boolean;
  unsupportedSources: ("local" | "google")[];
} {
  const matches: ConflictMatch[] = [];
  const unsupportedSources = new Set<"local" | "google">();
  if (!conflictTemporalReady(candidate.temporal))
    return { matches, unsupported: false, unsupportedSources: [] };
  const a = interval(candidate, timezone);
  if (!a)
    return {
      matches,
      unsupported: true,
      unsupportedSources: ["local", "google"],
    };
  const groups = new Map<string, DuplicateRecord[]>();
  for (const r of records) {
    if (r.source === "local" && !r.commitment) continue;
    const key =
      r.calendarId === "primary" && r.providerEventId
        ? "primary:" + r.providerEventId
        : r.source + ":" + r.key;
    const group = groups.get(key) || [];
    group.push(r);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const live = group.find((r) => r.source === "google"),
      local = group.find((r) => r.source === "local");
    const record = live || group[0];
    // A confirmed group already warned as a duplicate must not also imply a different commitment.
    if (group.some((r) => compareDuplicate(candidate, r))) continue;
    if (record.source === "google" && record.availability === "free") continue;
    if (record.source === "google" && record.availability !== "busy") {
      unsupportedSources.add("google");
      continue;
    }
    const b = interval(record, timezone);
    if (!b) {
      unsupportedSources.add(record.source);
      continue;
    }
    if (!(a.start < b.end && b.start < a.end)) continue;
    matches.push({
      key: record.key,
      sources: [...new Set(group.map((r) => r.source))],
      kind:
        candidate.temporal?.kind === "all_day" ||
        record.temporal?.kind === "all_day"
          ? "all_day_overlap"
          : "timed_overlap",
      facts: {
        title: record.title,
        location: record.location,
        temporal: record.temporal as ConflictMatch["facts"]["temporal"],
      },
      overlap: {
        start: a.start > b.start ? a.start : b.start,
        end: a.end < b.end ? a.end : b.end,
      },
      ...(local?.reviewId ? { reviewId: local.reviewId } : {}),
      ...(record.providerEventId
        ? {
            providerEventId: record.providerEventId,
            calendarId: record.calendarId,
          }
        : {}),
      ...(record.htmlLink ? { htmlLink: record.htmlLink } : {}),
    });
  }
  return {
    matches,
    unsupported: unsupportedSources.size > 0,
    unsupportedSources: [...unsupportedSources],
  };
}
