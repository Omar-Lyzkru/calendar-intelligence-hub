import { beforeEach, expect, it, vi } from "vitest";
import { googleCalendar } from "./calendar.js";
import { AppError, type DuplicateWindow } from "@hub/contracts";
const { request, auth } = vi.hoisted(() => ({
  request: vi.fn(),
  auth: vi.fn(),
}));
vi.mock("./providerClient.js", () => ({ providerClient: auth }));
const config = {
  NODE_ENV: "test" as const,
  PORT: 3000,
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgresql://synthetic",
  GOOGLE_CLIENT_ID: "synthetic",
  GOOGLE_CLIENT_SECRET: "synthetic",
  GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
  TOKEN_ENCRYPTION_KEY: "1".repeat(64),
  PROVIDER_TIMEOUT_MS: 1000,
};
const window: DuplicateWindow = {
  timeMin: "2026-10-09T00:00:00.000Z",
  timeMax: "2026-10-12T00:00:00.000Z",
  dateMin: "2026-10-09",
  dateMax: "2026-10-12",
};
const event = {
  id: "manual",
  summary: "CodeRED Orion",
  location: "Hall",
  start: { dateTime: "2026-10-10T10:00:00-05:00", timeZone: "America/Chicago" },
  end: { dateTime: "2026-10-10T11:00:00-05:00", timeZone: "America/Chicago" },
  htmlLink: "https://calendar.google.com/calendar/event?eid=synthetic",
  description: "PRIVATE DESCRIPTION",
  attendees: [{ email: "private@example.test" }],
};
beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue({ request });
});
it("reads manual events with existing permission and a privacy projection without mutations", async () => {
  request.mockResolvedValue({ data: { items: [event] } });
  const g = googleCalendar(config);
  expect(typeof g.list).toBe("function");
  const r = await g.list!({ userId: "user" }, window);
  expect(r.coverage.status).toBe("checked");
  expect(r.events[0]).toMatchObject({
    source: "google",
    providerEventId: "manual",
    temporal: {
      start: "2026-10-10T15:00:00.000Z",
      end: "2026-10-10T16:00:00.000Z",
    },
  });
  expect(JSON.stringify(r)).not.toMatch(
    /PRIVATE DESCRIPTION|private@example|attendees|description/,
  );
  expect(auth.mock.calls[0][1]).toBe(
    "https://www.googleapis.com/auth/calendar.events.owned",
  );
  const options = request.mock.calls[0][0];
  expect(options.method).toBe("GET");
  expect(options.params).toMatchObject({
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    singleEvents: true,
    showDeleted: false,
    maxResults: 50,
  });
  expect(options.params.fields).not.toMatch(
    /description|attendees|extendedProperties/,
  );
  expect(options.data).toBeUndefined();
});
it("follows short or empty pagination and reports remaining pages as incomplete", async () => {
  request
    .mockResolvedValueOnce({ data: { items: [], nextPageToken: "page2" } })
    .mockResolvedValueOnce({ data: { items: [event], nextPageToken: "page3" } })
    .mockResolvedValueOnce({
      data: { items: [{ ...event, id: "manual2" }], nextPageToken: "page4" },
    });
  const r = await googleCalendar(config).list!({ userId: "user" }, window);
  expect(r.events).toHaveLength(2);
  expect(r.coverage).toEqual({ status: "partial", reason: "limit_reached" });
  expect(request.mock.calls).toHaveLength(3);
  expect(request.mock.calls[1][0].params.pageToken).toBe("page2");
});
it("normalizes all-day dates and marks invalid items incomplete while excluding cancelled events", async () => {
  request.mockResolvedValue({
    data: {
      items: [
        {
          ...event,
          id: "all",
          start: { date: "2026-10-10" },
          end: { date: "2026-10-11" },
        },
        { ...event, id: "cancelled", status: "cancelled" },
        { ...event, id: "invalid", end: { dateTime: "bad" } },
      ],
    },
  });
  const r = await googleCalendar(config).list!({ userId: "user" }, window);
  expect(r.coverage).toEqual({
    status: "partial",
    reason: "unsupported_events",
  });
  expect(r.events).toHaveLength(1);
  expect(r.events[0].temporal).toEqual({
    kind: "all_day",
    startDate: "2026-10-10",
    endExclusive: "2026-10-11",
  });
});
it("first-page failures and missing authorization never become clean results or expose errors", async () => {
  request.mockRejectedValue(Error("SECRET SENTINEL"));
  const r = await googleCalendar(config).list!({ userId: "user" }, window);
  expect(r).toEqual({
    events: [],
    coverage: { status: "unavailable", reason: "provider_unavailable" },
  });
  auth.mockRejectedValue(new AppError("reauthorization_required", 403));
  expect(
    await googleCalendar(config).list!({ userId: "user" }, window),
  ).toEqual({
    events: [],
    coverage: { status: "unavailable", reason: "reauthorization_required" },
  });
  expect(JSON.stringify(r)).not.toContain("SECRET");
});
it("later-page failure retains prior facts but marks partial", async () => {
  request
    .mockResolvedValueOnce({ data: { items: [event], nextPageToken: "next" } })
    .mockRejectedValue({ response: { status: 429 } });
  const r = await googleCalendar(config).list!({ userId: "user" }, window);
  expect(r.events).toHaveLength(1);
  expect(r.coverage).toEqual({
    status: "partial",
    reason: "provider_rate_limited",
  });
});
it("projects conflict availability and source Calendar timezone without private attendee data", async () => {
  request.mockResolvedValue({
    data: {
      timeZone: "Asia/Tokyo",
      items: [
        { ...event, id: "free", transparency: "transparent" },
        {
          ...event,
          id: "day",
          start: { date: "2026-10-10" },
          end: { date: "2026-10-11" },
        },
        { ...event, id: "unspecified", endTimeUnspecified: true },
        { ...event, id: "unknown", transparency: "unexpected" },
      ],
    },
  });
  const r = await googleCalendar(config).list!({ userId: "user" }, window);
  expect(
    r.events.map((x) => [
      x.providerEventId,
      x.availability,
      x.calendarTimezone,
    ]),
  ).toEqual([
    ["free", "free", "Asia/Tokyo"],
    ["day", "busy", "Asia/Tokyo"],
    ["unspecified", "unknown", "Asia/Tokyo"],
    ["unknown", "unknown", "Asia/Tokyo"],
  ]);
  expect(request.mock.calls[0][0].params.fields).toMatch(/timeZone/);
  expect(request.mock.calls[0][0].params.fields).toMatch(/transparency/);
  expect(request.mock.calls[0][0].params.fields).not.toMatch(
    /attendees|description/,
  );
});
