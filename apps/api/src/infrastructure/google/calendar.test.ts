import { it, expect } from "vitest";
import { toCalendarPayload } from "./calendar.js";
it("all_day_dates_remain_dates", () => {
  expect(
    toCalendarPayload({
      title: "Exam",
      location: null,
      description: null,
      category: "event",
      temporal: {
        kind: "all_day",
        startDate: "2026-10-08",
        endExclusive: "2026-10-09",
      },
    }),
  ).toMatchObject({
    start: { date: "2026-10-08" },
    end: { date: "2026-10-09" },
  });
});
it("timed_payload_preserves_timezone", () => {
  expect(
    toCalendarPayload({
      title: "Workshop",
      location: null,
      description: null,
      category: "event",
      temporal: {
        kind: "timed",
        start: "2026-10-08T19:00:00.000Z",
        end: "2026-10-08T20:00:00.000Z",
        timezone: "America/Chicago",
      },
    }),
  ).toMatchObject({
    start: {
      dateTime: "2026-10-08T19:00:00.000Z",
      timeZone: "America/Chicago",
    },
    end: { dateTime: "2026-10-08T20:00:00.000Z", timeZone: "America/Chicago" },
  });
});

import { calendarReceipt, payloadHash } from "./calendar.js";
import type { ReadyEvent } from "@hub/contracts";
const base = {
  title: "Workshop",
  location: null,
  description: null,
  category: "event" as const,
};
const timed: ReadyEvent = {
  ...base,
  temporal: {
    kind: "timed",
    start: "2026-10-08T19:00:00.123Z",
    end: "2026-10-08T20:00:00.123Z",
    timezone: "America/Chicago",
  },
};
const allDay: ReadyEvent = {
  ...base,
  temporal: {
    kind: "all_day",
    startDate: "2026-10-08",
    endExclusive: "2026-10-09",
  },
};
it("historic commitment hashes remain literal and provenance independent", () => {
  expect(payloadHash(timed)).toBe(
    "c7908948292d0be6c1fb746e7995478281f401d393096748eb8c8e38d81d6d63",
  );
  expect(payloadHash(allDay)).toBe(
    "e9a6c5801882bdf6157f009f02ca7a474b3690c8b35d34a0e0d7bfe80e8924c1",
  );
  expect(
    payloadHash({
      ...timed,
      category: "deadline",
      temporal: { ...timed.temporal, timezoneProvenance: "explicit" },
    } as ReadyEvent),
  ).toBe(payloadHash(timed));
  const p = {
    ...toCalendarPayload(timed),
    id: "synthetic",
    start: { dateTime: "2026-10-08T14:00:00.123-05:00" },
    end: { dateTime: "2026-10-08T15:00:00.123-05:00" },
    extendedProperties: { private: { hubPayloadHash: payloadHash(timed) } },
  };
  expect(calendarReceipt(p).payloadHash).toBe(payloadHash(timed));
  expect(calendarReceipt({ ...p, status: "cancelled" }).payloadHash).toBe(
    "mismatch",
  );
});
it("invalid runtime drafts never serialize", () => {
  for (const temporal of [
    { kind: "date_only", startDate: "2026-10-08", endDateInclusive: null },
    { kind: "unresolved", text: "Unknown" },
    { kind: "all_day", startDate: "2026-02-30", endExclusive: "2026-03-02" },
    { ...timed.temporal, end: "2026-10-08T18:00:00.000Z" },
  ])
    expect(() =>
      toCalendarPayload({ ...base, temporal } as ReadyEvent),
    ).toThrow();
});
it("malformed provider endpoints cannot confirm a receipt", () => {
  const p = {
    ...toCalendarPayload(timed),
    id: "synthetic",
    extendedProperties: { private: { hubPayloadHash: payloadHash(timed) } },
  };
  for (const start of [
    { dateTime: "2026-10-08T19:00:00.123" },
    { dateTime: "2026-02-30T19:00:00.123Z" },
    { dateTime: "2026-10-08T19:00:00.123001Z" },
    { date: "2026-10-08", dateTime: "2026-10-08T19:00:00.123Z" },
    { date: "2026-10-08" },
    { dateTime: "2026-10-09T19:00:00.123Z" },
  ])
    expect(() => calendarReceipt({ ...p, start })).toThrow();
});
import { vi } from "vitest";
import { providerClient } from "./providerClient.js";
import { googleCalendar } from "./calendar.js";
import type { Config } from "../../config/env.js";
vi.mock("./providerClient.js", () => ({ providerClient: vi.fn() }));
it("direct insert rejects a non-ready event before authentication/provider access", async () => {
  const gateway = googleCalendar({} as Config);
  await expect(
    gateway.insert(
      { userId: "synthetic" },
      "synthetic",
      {
        ...base,
        temporal: {
          kind: "date_only",
          startDate: "2026-10-20",
          endDateInclusive: null,
        },
      } as unknown as ReadyEvent,
      "synthetic",
    ),
  ).rejects.toMatchObject({ code: "invalid_calendar_event" });
  expect(providerClient).not.toHaveBeenCalled();
});
it("taxonomy edits leave timed/all-day payloads, hashes and receipts unchanged", () => {
  for (const legacy of [timed, allDay]) {
    const classified = { ...legacy, eventCategory: "career" as const };
    expect(toCalendarPayload(classified)).toEqual(toCalendarPayload(legacy));
    expect(payloadHash(classified)).toBe(payloadHash(legacy));
    const p = {
      ...toCalendarPayload(legacy),
      id: "synthetic",
      extendedProperties: { private: { hubPayloadHash: payloadHash(legacy) } },
    };
    expect(calendarReceipt(p).payloadHash).toBe(payloadHash(classified));
  }
});
