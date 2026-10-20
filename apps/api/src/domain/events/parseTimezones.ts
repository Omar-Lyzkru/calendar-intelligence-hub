import type {
  Evidence,
  TemporalIssue,
  TimezoneProvenance,
} from "@hub/contracts";
import { parseTimes } from "./parseTimes.js";
import type { DateToken } from "./parseDates.js";
export type ZoneResolution =
  | {
      kind: "resolved";
      timezone: string;
      provenance: TimezoneProvenance;
      evidence: Evidence[];
    }
  | { kind: "unresolved"; evidence: Evidence[]; issues: TemporalIssue[] };
export const namedZones: Record<string, string> = {
  "eastern time": "America/New_York",
  "central time": "America/Chicago",
  "mountain time": "America/Denver",
  "pacific time": "America/Los_Angeles",
  utc: "UTC",
};
export const corroboratingOffsets: Record<
  string,
  { timezone: string; offset: string }
> = {
  CST: { timezone: "America/Chicago", offset: "-06:00" },
  CDT: { timezone: "America/Chicago", offset: "-05:00" },
  EST: { timezone: "America/New_York", offset: "-05:00" },
  EDT: { timezone: "America/New_York", offset: "-04:00" },
  MST: { timezone: "America/Denver", offset: "-07:00" },
  MDT: { timezone: "America/Denver", offset: "-06:00" },
  PST: { timezone: "America/Los_Angeles", offset: "-08:00" },
  PDT: { timezone: "America/Los_Angeles", offset: "-07:00" },
};
export function parseTimezones(
  text: string,
  origin: DateToken["origin"],
  configuredZone: string,
): ZoneResolution {
  const masked = text.replace(/https?:\/\/\S+|\S+@\S+/g, (m) =>
    " ".repeat(m.length),
  );
  const zones = new Set<string>(),
    evidence: Evidence[] = [],
    abbreviations: string[] = [];
  for (const m of masked.matchAll(
    /\b(?:[A-Za-z]+(?:\s+(?:Standard|Daylight|Summer))?\s+Time|UTC|[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/gi,
  )) {
    const value = namedZones[m[0].toLowerCase()] || m[0];
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      zones.add(value);
    } catch {
      zones.add("unsupported");
    }
    evidence.push({
      code: "explicit_timezone",
      origin,
      text: m[0],
      start: m.index,
      end: m.index! + m[0].length,
    });
  }
  for (const m of masked.matchAll(
    /\b(?:CST|CDT|EST|EDT|MST|MDT|PST|PDT|IST|BST|CEST|CET|GMT|ET|CT|MT|PT)\b/gi,
  )) {
    abbreviations.push(m[0].toUpperCase());
    evidence.push({
      code: "timezone_abbreviation",
      origin,
      text: m[0],
      start: m.index,
      end: m.index! + m[0].length,
    });
  }
  for (const token of parseTimes(masked, origin).tokens) {
    const suffix = masked.slice(token.end).match(/^\s+([A-Za-z]{2,5})\b(?!\/)/);
    if (
      suffix &&
      suffix[1].toUpperCase() !== "UTC" &&
      !abbreviations.includes(suffix[1].toUpperCase()) &&
      ![
        "am",
        "pm",
        "to",
        "until",
        "and",
        "or",
        "at",
        "on",
        "in",
        "with",
        "for",
        "from",
        "after",
        "before",
        "of",
        "the",
        "by",
      ].includes(suffix[1].toLowerCase())
    ) {
      abbreviations.push(suffix[1].toUpperCase());
      const start = token.end + suffix[0].indexOf(suffix[1]);
      evidence.push({
        code: "timezone_abbreviation",
        origin,
        text: suffix[1],
        start,
        end: start + suffix[1].length,
      });
    }
  }
  const problem =
    zones.size > 1 ||
    zones.has("unsupported") ||
    /\b(?:UTC|GMT)[+-]\d/i.test(masked) ||
    abbreviations.some(
      (a) =>
        !corroboratingOffsets[a] ||
        zones.size !== 1 ||
        !zones.has(corroboratingOffsets[a].timezone),
    );
  // Preserve the cause without changing established temporal issue codes.
  if (zones.size > 1 && !zones.has("unsupported"))
    evidence.push({ code: "conflicting_zones", origin });
  if (problem)
    return {
      kind: "unresolved",
      evidence,
      issues: [
        {
          field: "timezone",
          code: "unresolved_timezone",
          message:
            "Correct the ambiguous, unsupported, or conflicting timezone.",
        },
      ],
    };
  const timezone = zones.size ? [...zones][0] : configuredZone;
  return {
    kind: "resolved",
    timezone,
    provenance: zones.size ? "explicit" : "assumed",
    evidence,
  };
}
