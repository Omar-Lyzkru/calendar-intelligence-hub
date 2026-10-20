import { it, expect } from "vitest";
import {
  canonicalCalendarDate,
  canonicalInstant,
  resolveLocalTime,
  chooseLocalTime,
} from "./temporal.js";
it.each([
  ["2026-01-20T14:30", "America/Chicago", "2026-01-20T20:30:00.000Z"],
  ["2026-10-20T14:30", "America/Chicago", "2026-10-20T19:30:00.000Z"],
  ["2026-10-20T15:00", "America/New_York", "2026-10-20T19:00:00.000Z"],
])("resolves %s in %s with real zone rules", (local, zone, instant) =>
  expect(resolveLocalTime(local, zone)).toEqual({ kind: "normal", instant }),
);
it("distinguishes repeated time and rejects gaps for every occurrence choice", () => {
  expect(resolveLocalTime("2026-11-01T01:30", "America/Chicago")).toMatchObject(
    {
      kind: "repeated",
      earlier: "2026-11-01T06:30:00.000Z",
      later: "2026-11-01T07:30:00.000Z",
      earlierOffset: "-05:00",
      laterOffset: "-06:00",
    },
  );
  for (const choice of ["reject", "earlier", "later"] as const)
    expect(
      chooseLocalTime("2026-03-08T02:30", "America/Chicago", choice).ok,
    ).toBe(false);
  expect(
    chooseLocalTime("2026-11-01T01:30", "America/Chicago", "reject").ok,
  ).toBe(false);
});
it("rejects impossible dates, accepts leap dates, and never constrains overflow", () => {
  for (const date of ["2026-02-30", "2026-02-29", "2026-13-01"])
    expect(canonicalCalendarDate(date).ok).toBe(false);
  expect(canonicalCalendarDate("2028-02-29")).toEqual({
    ok: true,
    date: "2028-02-29",
  });
  expect(resolveLocalTime("2026-02-30T14:30", "America/Chicago").kind).toBe(
    "invalid",
  );
  expect(resolveLocalTime("2026-10-20T14:30", "bad/zone").kind).toBe("invalid");
});
it("requires explicit-offset real instants and exact millisecond precision", () => {
  for (const value of [
    "2026-02-30T14:30:00Z",
    "2026-10-20T14:30:00",
    "2026-10-20T14:30:00.0001Z",
  ])
    expect(canonicalInstant(value).ok).toBe(false);
  expect(canonicalInstant("2026-10-20T14:30:00.123000-05:00")).toEqual({
    ok: true,
    instant: "2026-10-20T19:30:00.123Z",
  });
});
