import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import {
  AllDaySchema,
  DateOnlySchema,
  TimedSchema,
  EditableEventDraftSchema,
  type EventDraft,
} from "./events.js";
import { isUsableTitle } from "./readiness.js";
export const DuplicateTemporalSchema = z
  .union([TimedSchema, AllDaySchema, DateOnlySchema])
  .nullable();
export const DuplicateFactsSchema = z.object({
  title: z.string().max(300),
  location: z.string().max(1000).nullable(),
  temporal: DuplicateTemporalSchema,
});
export const DuplicateEvidenceSchema = z.enum([
  "same_source",
  "same_provider_event",
  "same_commitment_hash",
  "same_title",
  "similar_title",
  "same_time",
  "near_start_overlap",
  "same_dates",
  "date_only_unconfirmed",
  "same_duration",
  "same_location",
  "different_location",
]);
export const DuplicateCoverageSchema = z.object({
  status: z.enum(["checked", "partial", "skipped", "unavailable"]),
  reason: z
    .enum([
      "unresolved_time",
      "limit_reached",
      "unsupported_events",
      "provider_unavailable",
      "reauthorization_required",
      "provider_rate_limited",
      "local_unavailable",
      "already_added",
    ])
    .optional(),
});
export const DuplicateWindowSchema = z.object({
  timeMin: z.iso.datetime(),
  timeMax: z.iso.datetime(),
  dateMin: z.iso.date(),
  dateMax: z.iso.date(),
});
export const DuplicateMatchSchema = z.object({
  key: z.string(),
  strength: z.enum(["exact_identity", "strong_possible", "possible"]),
  sources: z
    .array(z.enum(["local", "google"]))
    .min(1)
    .max(2),
  facts: DuplicateFactsSchema,
  evidence: z.array(DuplicateEvidenceSchema),
  reviewId: z.uuid().optional(),
  providerEventId: z.string().optional(),
  calendarId: z.literal("primary").optional(),
  htmlLink: z
    .url()
    .refine((v) => {
      const u = new URL(v);
      return u.protocol === "https:" && u.hostname === "calendar.google.com";
    })
    .optional(),
});
export const ConflictMatchSchema = DuplicateMatchSchema.omit({
  strength: true,
  evidence: true,
}).extend({
  kind: z.enum(["timed_overlap", "all_day_overlap"]),
  overlap: z.object({ start: z.iso.datetime(), end: z.iso.datetime() }),
});
export const ConflictCheckSchema = z.object({
  timezone: z.string(),
  local: DuplicateCoverageSchema,
  google: DuplicateCoverageSchema,
  matches: z.array(ConflictMatchSchema).max(20),
  truncated: z.boolean(),
});
export type ConflictMatch = z.infer<typeof ConflictMatchSchema>;
export type ConflictCheck = z.infer<typeof ConflictCheckSchema>;
export const DuplicateCheckSchema = z.object({
  reviewId: z.uuid(),
  revision: z.number().int().positive(),
  checkedAt: z.iso.datetime(),
  window: DuplicateWindowSchema.nullable(),
  local: DuplicateCoverageSchema,
  google: DuplicateCoverageSchema,
  matches: z.array(DuplicateMatchSchema).max(20),
  truncated: z.boolean(),
  conflicts: ConflictCheckSchema.optional(),
});
export type DuplicateCheck = z.infer<typeof DuplicateCheckSchema>;
export type DuplicateMatch = z.infer<typeof DuplicateMatchSchema>;
export type DuplicateCoverage = z.infer<typeof DuplicateCoverageSchema>;
export type DuplicateWindow = z.infer<typeof DuplicateWindowSchema>;
export interface DuplicateRecord {
  key: string;
  source: "local" | "google";
  title: string;
  location: string | null;
  temporal: EventDraft["temporal"] | null;
  reviewId?: string;
  // Local IDs are included only after receipt and immutable hash validation.
  providerEventId?: string;
  calendarId?: "primary";
  htmlLink?: string;
  sourceIdentity?: { connectionId: string; externalId: string };
  payloadHash?: string;
  // Advisory-only metadata; never part of immutable commitments or hashes.
  commitment?: boolean;
  availability?: "busy" | "free" | "unknown";
  calendarTimezone?: string;
}
const normalized = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(" ") || "";
function titleEvidence(
  a: string,
  b: string,
): "same_title" | "similar_title" | null {
  if (!isUsableTitle(a) || !isUsableTitle(b)) return null;
  const na = normalized(a),
    nb = normalized(b);
  if (!na || !nb) return null;
  if (na === nb) return "same_title";
  const sa = new Set(na.split(" ")),
    sb = new Set(nb.split(" "));
  const shared = [...sa].filter((v) => sb.has(v)).length;
  return shared >= 2 &&
    shared / Math.min(sa.size, sb.size) >= 0.6 &&
    shared / (sa.size + sb.size - shared) >= 0.5
    ? "similar_title"
    : null;
}
function period(t: DuplicateRecord["temporal"]): {
  kind: "timed" | "dates";
  start: string;
  end: string | null;
  unconfirmed: boolean;
} | null {
  try {
    if (!t || t.kind === "unresolved") return null;
    if (t.kind === "timed") {
      const p = TimedSchema.parse(t);
      const start = Temporal.Instant.from(p.start).toString({
        fractionalSecondDigits: 3,
      });
      const end = p.end
        ? Temporal.Instant.from(p.end).toString({ fractionalSecondDigits: 3 })
        : null;
      if (end && end <= start) return null;
      return { kind: "timed", start, end, unconfirmed: false };
    }
    if (t.kind === "all_day") {
      const p = AllDaySchema.parse(t);
      return p.endExclusive > p.startDate
        ? {
            kind: "dates",
            start: p.startDate,
            end: p.endExclusive,
            unconfirmed: false,
          }
        : null;
    }
    const p = DateOnlySchema.parse(t);
    return {
      kind: "dates",
      start: p.startDate,
      end: Temporal.PlainDate.from(p.endDateInclusive || p.startDate)
        .add({ days: 1 })
        .toString(),
      unconfirmed: true,
    };
  } catch {
    return null;
  }
}
export function duplicateWindow(
  input: unknown,
  zone: string,
): DuplicateWindow | null {
  const p = EditableEventDraftSchema.safeParse(input);
  if (!p.success) return null;
  const t = period(p.data.temporal);
  if (!t) return null;
  try {
    let start: Temporal.Instant, end: Temporal.Instant;
    const pad = t.kind === "timed" ? 24 : 36;
    if (t.kind === "timed") {
      start = Temporal.Instant.from(t.start);
      end = t.end ? Temporal.Instant.from(t.end) : start;
      if (end.epochMilliseconds - start.epochMilliseconds > 31 * 86400000)
        return null;
    } else {
      const a = Temporal.PlainDate.from(t.start),
        b = Temporal.PlainDate.from(t.end!);
      if (a.until(b).days > 31) return null;
      start = a.toZonedDateTime(zone).toInstant();
      end = b.toZonedDateTime(zone).toInstant();
    }
    const min = start
      .subtract({ hours: pad })
      .toString({ fractionalSecondDigits: 3 });
    const max = end.add({ hours: pad }).toString({ fractionalSecondDigits: 3 });
    return {
      timeMin: min,
      timeMax: max,
      dateMin: min.slice(0, 10),
      dateMax: max.slice(0, 10),
    };
  } catch {
    return null;
  }
}
export function compareDuplicate(
  a: DuplicateRecord,
  b: DuplicateRecord,
): DuplicateMatch | null {
  const evidence: DuplicateMatch["evidence"] = [];
  let strength: DuplicateMatch["strength"] = "possible";
  if (
    a.sourceIdentity &&
    b.sourceIdentity &&
    a.sourceIdentity.connectionId === b.sourceIdentity.connectionId &&
    a.sourceIdentity.externalId === b.sourceIdentity.externalId
  ) {
    evidence.push("same_source");
    strength = "exact_identity";
  }
  if (
    a.providerEventId &&
    a.providerEventId === b.providerEventId &&
    a.calendarId === b.calendarId &&
    a.calendarId === "primary"
  ) {
    evidence.push("same_provider_event");
    strength = "exact_identity";
  }
  if (strength !== "exact_identity") {
    const title = titleEvidence(a.title, b.title),
      ta = period(a.temporal),
      tb = period(b.temporal);
    if (!title || !ta || !tb || ta.kind !== tb.kind) return null;
    evidence.push(title);
    if (ta.kind === "dates") {
      if (ta.start !== tb.start || ta.end !== tb.end) return null;
      evidence.push("same_dates");
      if (ta.unconfirmed || tb.unconfirmed)
        evidence.push("date_only_unconfirmed");
      else strength = "strong_possible";
    } else {
      const sa = Date.parse(ta.start),
        sb = Date.parse(tb.start);
      if (sa === sb) {
        evidence.push("same_time");
        if (ta.end && tb.end && ta.end === tb.end) {
          strength = "strong_possible";
          evidence.push("same_duration");
        }
      } else {
        if (!ta.end || !tb.end || Math.abs(sa - sb) > 15 * 60000) return null;
        const ea = Date.parse(ta.end),
          eb = Date.parse(tb.end);
        if (
          Math.min(ea, eb) - Math.max(sa, sb) <
          0.5 * Math.min(ea - sa, eb - sb)
        )
          return null;
        evidence.push("near_start_overlap");
        if (ea - sa === eb - sb) evidence.push("same_duration");
      }
    }
    if (a.payloadHash && a.payloadHash === b.payloadHash)
      evidence.push("same_commitment_hash");
  }
  const la = normalized(a.location || ""),
    lb = normalized(b.location || "");
  if (la && lb) {
    if (la === lb) evidence.push("same_location");
    else {
      evidence.push("different_location");
      if (strength === "strong_possible") strength = "possible";
    }
  }
  const temporal = b.temporal?.kind === "unresolved" ? null : b.temporal;
  return DuplicateMatchSchema.parse({
    key: b.key,
    strength,
    sources: [b.source],
    facts: {
      title: b.title.slice(0, 300),
      location: b.location?.slice(0, 1000) || null,
      temporal,
    },
    evidence,
    reviewId: b.reviewId,
    providerEventId: b.providerEventId,
    calendarId: b.calendarId,
    htmlLink: b.htmlLink,
  });
}
export function mergeDuplicateMatches(
  matches: DuplicateMatch[],
): DuplicateMatch[] {
  const result: DuplicateMatch[] = [];
  for (const m of matches) {
    const existing = m.providerEventId
      ? result.find(
          (v) =>
            v.providerEventId === m.providerEventId &&
            v.calendarId === m.calendarId,
        )
      : undefined;
    if (!existing) {
      result.push({ ...m, sources: [...m.sources], evidence: [...m.evidence] });
      continue;
    }
    const identity = [
      ...new Set(
        [...existing.evidence, ...m.evidence].filter(
          (e) => e === "same_source" || e === "same_provider_event",
        ),
      ),
    ];
    const live = m.sources.includes("google") ? m : existing;
    existing.sources = [...new Set([...existing.sources, ...m.sources])];
    existing.reviewId ||= m.reviewId;
    existing.strength = identity.length ? "exact_identity" : live.strength;
    existing.evidence = [...new Set([...identity, ...live.evidence])];
    existing.facts = live.facts;
    existing.htmlLink = live.htmlLink;
  }
  return result;
}
