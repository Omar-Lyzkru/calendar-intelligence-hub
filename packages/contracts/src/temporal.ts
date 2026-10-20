import { Temporal } from "@js-temporal/polyfill";
export interface TemporalIssue {
  field: string;
  code: string;
  message: string;
}
export type Result<T> =
  ({ ok: true } & T) | { ok: false; issues: TemporalIssue[] };
export const issue = (
  field: string,
  code: string,
  message: string,
): Result<never> => ({ ok: false, issues: [{ field, code, message }] });
export function canonicalCalendarDate(
  input: unknown,
): Result<{ date: string }> {
  try {
    if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input))
      throw Error();
    const date = Temporal.PlainDate.from(input, { overflow: "reject" });
    return { ok: true, date: date.toString() };
  } catch {
    return issue(
      "date",
      "invalid_date",
      "Enter a valid complete calendar date.",
    );
  }
}
export function canonicalInstant(input: unknown): Result<{ instant: string }> {
  try {
    if (
      typeof input !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        input,
      )
    )
      throw Error();
    const local = input.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "");
    if (Number(local.slice(17, 19)) >= 60) throw Error();
    Temporal.PlainDateTime.from(local, { overflow: "reject" });
    const instant = Temporal.Instant.from(input);
    if (instant.epochNanoseconds % 1000000n !== 0n) throw Error();
    return {
      ok: true,
      instant: instant.toString({ fractionalSecondDigits: 3 }),
    };
  } catch {
    return issue(
      "instant",
      "invalid_instant",
      "Enter an explicit-offset valid instant with millisecond precision.",
    );
  }
}
export type LocalTimeResolution =
  | { kind: "normal"; instant: string }
  | {
      kind: "repeated";
      earlier: string;
      later: string;
      earlierOffset: string;
      laterOffset: string;
    }
  | { kind: "gap" }
  | { kind: "invalid"; issues: TemporalIssue[] };
export function resolveLocalTime(
  local: string,
  zone: string,
): LocalTimeResolution {
  try {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(local) ||
      Number(local.slice(17, 19) || 0) >= 60
    )
      throw Error();
    new Intl.DateTimeFormat("en", { timeZone: zone });
    const value = Temporal.PlainDateTime.from(local, { overflow: "reject" });
    const earlier = value.toZonedDateTime(zone, { disambiguation: "earlier" }),
      later = value.toZonedDateTime(zone, { disambiguation: "later" });
    if (
      !earlier.toPlainDateTime().equals(value) ||
      !later.toPlainDateTime().equals(value)
    )
      return { kind: "gap" };
    const iso = (v: Temporal.ZonedDateTime) =>
      v.toInstant().toString({ fractionalSecondDigits: 3 });
    return earlier.epochNanoseconds === later.epochNanoseconds
      ? { kind: "normal", instant: iso(earlier) }
      : {
          kind: "repeated",
          earlier: iso(earlier),
          later: iso(later),
          earlierOffset: earlier.offset,
          laterOffset: later.offset,
        };
  } catch {
    return {
      kind: "invalid",
      issues: [
        {
          field: "temporal",
          code: "invalid_local_time",
          message: "Enter a valid local date/time and IANA timezone.",
        },
      ],
    };
  }
}
export function chooseLocalTime(
  local: string,
  zone: string,
  occurrence: "reject" | "earlier" | "later",
): Result<{ instant: string }> {
  const result = resolveLocalTime(local, zone);
  if (result.kind === "normal") return { ok: true, instant: result.instant };
  if (result.kind === "repeated")
    return occurrence === "reject"
      ? issue(
          "temporal",
          "repeated_time",
          "Choose which occurrence of this local time you mean.",
        )
      : { ok: true, instant: result[occurrence] };
  return result.kind === "gap"
    ? issue(
        "temporal",
        "nonexistent_time",
        "This local time does not exist in this timezone. Correct it.",
      )
    : { ok: false, issues: result.issues };
}
