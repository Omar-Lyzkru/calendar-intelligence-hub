import { Temporal } from "@js-temporal/polyfill";
import {
  canonicalCalendarDate,
  type PartialTemporalFacts,
  type TemporalIssue,
} from "@hub/contracts";
export interface DateToken {
  origin: "subject" | "content";
  start: number;
  end: number;
  text: string;
  completeDate?: string;
  partial?: PartialTemporalFacts;
  issues: TemporalIssue[];
}
const months = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const monthDate =
  /\b(?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[,]?\s+)?(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:[,]?\s+(\d{4}))?\b/gi;
export function parseDates(
  text: string,
  origin: DateToken["origin"],
): DateToken[] {
  const tokens: DateToken[] = [];
  const add = (
    m: RegExpMatchArray,
    partial: PartialTemporalFacts,
    problem?: string,
  ) => {
    const prefix = text
      .slice(0, m.index)
      .match(
        /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+$/i,
      );
    if (!partial.weekday && prefix)
      partial = {
        ...partial,
        weekday: weekdays.indexOf(prefix[1].slice(0, 3).toLowerCase()) + 1,
      };
    const start = m.index! - (prefix?.[0].length || 0);
    const token: DateToken = {
      origin,
      start,
      end: m.index! + m[0].length,
      text: text.slice(start, m.index! + m[0].length),
      partial,
      issues: [],
    };
    const fail = (code: string, message: string) =>
      token.issues.push({ field: "date", code, message });
    if (problem)
      fail(
        problem,
        problem === "ambiguous_numeric_date"
          ? "This numeric date is ambiguous. Correct its format."
          : "Enter a valid complete calendar date.",
      );
    else if (!partial.year)
      fail("missing_year", "Choose a year for this date before approval.");
    else {
      const value = `${partial.year.toString().padStart(4, "0")}-${String(partial.month).padStart(2, "0")}-${String(partial.day).padStart(2, "0")}`;
      if (!canonicalCalendarDate(value).ok)
        fail("invalid_date", "Enter a valid complete calendar date.");
      else if (
        partial.weekday &&
        Temporal.PlainDate.from(value).dayOfWeek !== partial.weekday
      )
        fail(
          "weekday_mismatch",
          "The weekday does not match this date. Correct it.",
        );
      else token.completeDate = value;
    }
    tokens.push(token);
  };
  for (const m of text.matchAll(monthDate))
    add(m, {
      month: months.indexOf(m[2].slice(0, 3).toLowerCase()) + 1,
      day: Number(m[3]),
      ...(m[4] ? { year: Number(m[4]) } : {}),
      ...(m[1]
        ? { weekday: weekdays.indexOf(m[1].slice(0, 3).toLowerCase()) + 1 }
        : {}),
    });
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g))
    add(m, { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) });
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/g)) {
    const a = Number(m[1]),
      b = Number(m[2]),
      year = Number(m[3]);
    const alternatives = [
      { month: a, day: b },
      { month: b, day: a },
    ].filter(
      (v) =>
        canonicalCalendarDate(
          `${year.toString().padStart(4, "0")}-${String(v.month).padStart(2, "0")}-${String(v.day).padStart(2, "0")}`,
        ).ok,
    );
    const unique = [
      ...new Map(alternatives.map((v) => [`${v.month}/${v.day}`, v])).values(),
    ];
    if (m[3].length !== 4) add(m, {}, "missing_year");
    else if (unique.length === 1) add(m, { year, ...unique[0] });
    else
      add(
        m,
        { year, ...(unique.length ? { numericAlternatives: unique } : {}) },
        unique.length ? "ambiguous_numeric_date" : "invalid_date",
      );
  }
  return tokens.sort((a, b) => a.start - b.start);
}
