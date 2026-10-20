import { expect, it } from "vitest";
import { collectConflicts, conflictTemporalReady } from "./conflicts.js";
import type { DuplicateRecord } from "./duplicates.js";
const zone = "America/Chicago";
const timed = (
  start = "2026-10-10T15:00:00.000Z",
  end: string | null = "2026-10-10T16:00:00.000Z",
): DuplicateRecord => ({
  key: "candidate",
  source: "local",
  title: "Orion workshop",
  location: null,
  temporal: { kind: "timed", start, end, timezone: zone },
});
const other = (start?: string, end?: string): DuplicateRecord => ({
  ...timed(start, end),
  key: "other",
  title: "Dentist appointment",
  commitment: true,
});
const check = (a: DuplicateRecord, b: DuplicateRecord[]) =>
  collectConflicts(a, b, zone);
it("compares different-title commitments and reports exact half-open overlap", () => {
  const r = check(timed(), [
    other("2026-10-10T15:30:00.000Z", "2026-10-10T17:00:00.000Z"),
  ]);
  expect(r.matches).toHaveLength(1);
  expect(r.matches[0]).toMatchObject({
    kind: "timed_overlap",
    overlap: {
      start: "2026-10-10T15:30:00.000Z",
      end: "2026-10-10T16:00:00.000Z",
    },
  });
  expect(r.unsupported).toBe(false);
});
it("detects containment but not adjacent endpoints, even at millisecond precision", () => {
  expect(
    check(timed(), [
      other("2026-10-10T14:00:00.000Z", "2026-10-10T17:00:00.000Z"),
    ]).matches,
  ).toHaveLength(1);
  expect(
    check(timed(), [
      other("2026-10-10T16:00:00.000Z", "2026-10-10T17:00:00.000Z"),
    ]).matches,
  ).toHaveLength(0);
  expect(
    check(timed(), [
      other("2026-10-10T15:59:59.999Z", "2026-10-10T17:00:00.000Z"),
    ]).matches[0].overlap.start,
  ).toBe("2026-10-10T15:59:59.999Z");
});
it("does not infer durations, date-only interpretations or malformed intervals", () => {
  const date = {
    ...timed(),
    temporal: {
      kind: "date_only" as const,
      startDate: "2026-10-10",
      endDateInclusive: null,
    },
  };
  expect(conflictTemporalReady(date.temporal)).toBe(false);
  expect(check(date, [other()]).matches).toHaveLength(0);
  expect(check(timed(undefined, null), [other()]).matches).toHaveLength(0);
  expect(
    check(timed(), [
      other("2026-10-10T17:00:00.000Z", "2026-10-10T16:00:00.000Z"),
    ]).unsupported,
  ).toBe(true);
});
it("excludes draft records and free Calendar events but marks unknown availability incomplete", () => {
  expect(
    check(timed(), [
      { ...other(), commitment: false },
      { ...other(), source: "google", availability: "free" },
    ]).matches,
  ).toHaveLength(0);
  const r = check(timed(), [
    { ...other(), source: "google", availability: "unknown" },
  ]);
  expect(r.unsupported).toBe(true);
  expect(r.unsupportedSources).toEqual(["google"]);
});
it("keeps possible duplicates separate from different-commitment overlaps", () => {
  expect(
    check(timed(), [{ ...other(), title: "Orion workshop conference" }])
      .matches,
  ).toHaveLength(0);
  expect(
    check(timed(), [
      { ...other(), sourceIdentity: { connectionId: "c", externalId: "m" } },
    ]).matches,
  ).toHaveLength(1);
  expect(
    check(
      { ...timed(), sourceIdentity: { connectionId: "c", externalId: "m" } },
      [{ ...other(), sourceIdentity: { connectionId: "c", externalId: "m" } }],
    ).matches,
  ).toHaveLength(0);
});
it("uses real DST day boundaries for all-day overlaps without converting stored dates", () => {
  const day: DuplicateRecord = {
    ...timed(),
    temporal: {
      kind: "all_day",
      startDate: "2026-03-08",
      endExclusive: "2026-03-09",
    },
  };
  const dayOther = { ...day, key: "day", title: "Trip", commitment: true };
  const r = check(day, [dayOther]);
  expect(r.matches[0]).toMatchObject({
    kind: "all_day_overlap",
    overlap: {
      start: "2026-03-08T06:00:00.000Z",
      end: "2026-03-09T05:00:00.000Z",
    },
  });
  expect(day.temporal).toEqual({
    kind: "all_day",
    startDate: "2026-03-08",
    endExclusive: "2026-03-09",
  });
  expect(
    check(day, [
      {
        ...dayOther,
        temporal: {
          kind: "all_day",
          startDate: "2026-03-09",
          endExclusive: "2026-03-10",
        },
      },
    ]).matches,
  ).toHaveLength(0);
});
it("uses live all-day Calendar zone for mixed overlaps and flags missing zone", () => {
  const day: DuplicateRecord = {
    ...other(),
    source: "google",
    availability: "busy",
    calendarTimezone: "Asia/Tokyo",
    temporal: {
      kind: "all_day",
      startDate: "2026-10-11",
      endExclusive: "2026-10-12",
    },
  };
  expect(check(timed(), [day]).matches[0].kind).toBe("all_day_overlap");
  expect(
    check(timed(), [{ ...day, calendarTimezone: undefined }]).unsupported,
  ).toBe(true);
});
it("compares DST fallback occurrences as instants, not identical wall clocks", () => {
  const a = timed("2026-11-01T06:15:00.000Z", "2026-11-01T06:45:00.000Z");
  expect(
    check(a, [other("2026-11-01T07:15:00.000Z", "2026-11-01T07:45:00.000Z")])
      .matches,
  ).toHaveLength(0);
  expect(
    check(a, [other("2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z")])
      .matches,
  ).toHaveLength(1);
});
it("coalesces confirmed associations and lets live moved/free facts override local ones", () => {
  const local = {
    ...other(),
    providerEventId: "confirmed",
    calendarId: "primary" as const,
    reviewId: "00000000-0000-4000-8000-000000000002",
  };
  const live = {
    ...local,
    key: "google",
    source: "google" as const,
    availability: "busy" as const,
  };
  expect(check(timed(), [local, live]).matches).toHaveLength(1);
  expect(check(timed(), [local, live]).matches[0].sources).toEqual([
    "local",
    "google",
  ]);
  expect(
    check(timed(), [local, { ...live, availability: "free" }]).matches,
  ).toHaveLength(0);
  expect(
    check(timed(), [
      local,
      {
        ...live,
        temporal: other("2026-10-10T17:00:00.000Z", "2026-10-10T18:00:00.000Z")
          .temporal,
      },
    ]).matches,
  ).toHaveLength(0);
});
it("does not depend on usable titles to identify scheduling conflicts", () => {
  expect(
    check({ ...timed(), title: "" }, [{ ...other(), title: "" }]).matches,
  ).toHaveLength(1);
});
it("normalizes valid UTC precision before interval comparisons", () => {
  const a = timed("2026-10-10T15:00:00Z", "2026-10-10T16:00:00Z");
  const r = check(a, [
    other("2026-10-10T15:00:00.001Z", "2026-10-10T15:00:00.002Z"),
  ]);
  expect(r.matches[0].overlap).toEqual({
    start: "2026-10-10T15:00:00.001Z",
    end: "2026-10-10T15:00:00.002Z",
  });
});
it("never labels a confirmed local duplicate and renamed live copy as separate commitments", () => {
  const local = {
    ...other(),
    title: "Orion workshop conference",
    providerEventId: "confirmed",
    calendarId: "primary" as const,
  };
  const live = {
    ...local,
    title: "Renamed appointment",
    source: "google" as const,
    availability: "busy" as const,
  };
  expect(check(timed(), [local, live]).matches).toHaveLength(0);
});
