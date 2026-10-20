import type { TemporalIssue } from "@hub/contracts";
import { parseDates, type DateToken } from "./parseDates.js";
export interface TimeToken {
  origin: DateToken["origin"];
  start: number;
  end: number;
  text: string;
  clock: string;
}
export function parseTimes(
  text: string,
  origin: DateToken["origin"],
): { tokens: TimeToken[]; issues: TemporalIssue[] } {
  const tokens: TimeToken[] = [],
    issues: TemporalIssue[] = [];
  const masked = text.replace(/https?:\/\/\S+|\S+@\S+/g, (m) =>
    " ".repeat(m.length),
  );
  const add = (
    start: number,
    end: number,
    h: number,
    min: number,
    marker?: string,
  ) => {
    if (min > 59 || h < 0 || h > (marker ? 12 : 23) || (marker && h === 0)) {
      issues.push({
        field: "time",
        code: "invalid_time",
        message: "Enter a valid clock time.",
      });
      return;
    }
    const hour = marker
      ? (h % 12) + (marker.toUpperCase() === "PM" ? 12 : 0)
      : h;
    tokens.push({
      origin,
      start,
      end,
      text: text.slice(start, end),
      clock: `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
    });
  };
  const shared =
    /\b(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/gi;
  for (const m of masked.matchAll(shared)) {
    if (
      Number(m[1]) > Number(m[3]) ||
      (Number(m[1]) === Number(m[3]) && Number(m[2] || 0) >= Number(m[4] || 0))
    ) {
      issues.push({
        field: "time",
        code: "ambiguous_meridiem",
        message: "Supply explicit AM/PM for both times.",
      });
      continue;
    }
    const dash = m[0].search(/[-–]/),
      start = m.index!;
    add(start, start + dash, Number(m[1]), Number(m[2] || 0), m[5]);
    add(
      start + dash + 1,
      start + m[0].length,
      Number(m[3]),
      Number(m[4] || 0),
      m[5],
    );
  }
  const occupied = (start: number, end: number) =>
    tokens.some((t) => start < t.end && t.start < end);
  for (const m of masked.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/gi)) {
    const start = m.index!,
      end = start + m[0].length;
    if (!occupied(start, end))
      add(start, end, Number(m[1]), Number(m[2] || 0), m[3]);
  }
  const dates = parseDates(masked, origin);
  const clockContext = (start: number) => {
    const before = masked.slice(0, start);
    return (
      !before.trim() ||
      /\b(?:at|from|time|start|end)\s*:?\s*$/i.test(before) ||
      dates.some(
        (date) =>
          date.end <= start &&
          /^\s*(?:at|from|@)?\s*$/i.test(before.slice(date.end)),
      ) ||
      tokens.some((t) =>
        /^\s*(?:to|until|through|[-–])\s*$/i.test(masked.slice(t.end, start)),
      )
    );
  };
  for (const m of masked.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
    const start = m.index!,
      end = start + m[0].length;
    if (!occupied(start, end) && !/^\s*(?:AM|PM)\b/i.test(masked.slice(end))) {
      if (clockContext(start)) add(start, end, Number(m[1]), Number(m[2]));
      else
        issues.push({
          field: "time",
          code: "ambiguous_time_context",
          message:
            "Correct clock-shaped text without clear event-time context.",
        });
    }
  }
  return { tokens: tokens.sort((a, b) => a.start - b.start), issues };
}
