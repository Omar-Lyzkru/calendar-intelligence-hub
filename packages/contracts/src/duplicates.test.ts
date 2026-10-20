import { expect, it } from "vitest";
import * as rules from "./duplicates.js";
import type { EventDraft } from "./events.js";
const draft: EventDraft = {
  title: "CodeRED Orion",
  location: null,
  description: null,
  category: "event",
  temporal: {
    kind: "timed",
    start: "2026-10-10T15:00:00.000Z",
    end: "2026-10-10T16:00:00.000Z",
    timezone: "America/Chicago",
  },
};
const record = (changes: Record<string, unknown> = {}) => ({
  key: "other",
  source: "local" as const,
  title: draft.title,
  location: null,
  temporal: draft.temporal,
  ...changes,
});
it("similar title with the same interval gives explainable strong possible evidence", () => {
  const result = rules.compareDuplicate(
    record(),
    record({ title: "CodeRED Orion Hackathon" }),
  );
  expect(result?.strength).toBe("strong_possible");
  expect(result?.evidence).toEqual(
    expect.arrayContaining(["similar_title", "same_time", "same_duration"]),
  );
});
it("same title on another date and unrelated title at the same time are not duplicates", () => {
  expect(
    rules.compareDuplicate(
      record(),
      record({
        temporal: {
          ...draft.temporal,
          start: "2026-10-17T15:00:00.000Z",
          end: "2026-10-17T16:00:00.000Z",
        },
      }),
    ),
  ).toBeNull();
  expect(
    rules.compareDuplicate(record(), record({ title: "Lunch with friends" })),
  ).toBeNull();
  expect(
    rules.compareDuplicate(
      record(),
      record({
        temporal: {
          ...draft.temporal,
          start: "2026-10-10T15:30:00.000Z",
          end: "2026-10-10T16:30:00.000Z",
        },
      }),
    ),
  ).toBeNull();
});
it("near starts with substantial overlap are possible and location disagreements downgrade strength", () => {
  expect(
    rules.compareDuplicate(
      record(),
      record({
        temporal: {
          ...draft.temporal,
          start: "2026-10-10T15:10:00.000Z",
          end: "2026-10-10T16:10:00.000Z",
        },
      }),
    )?.strength,
  ).toBe("possible");
  expect(
    rules.compareDuplicate(
      record({ location: "Room 1" }),
      record({ location: "Room 2" }),
    )?.strength,
  ).toBe("possible");
});
it("source and receipt association are exact but same hash across reviews is advisory", () => {
  const identity = { connectionId: "connection", externalId: "message" };
  expect(
    rules.compareDuplicate(
      record({ sourceIdentity: identity }),
      record({ sourceIdentity: identity }),
    )?.strength,
  ).toBe("exact_identity");
  expect(
    rules.compareDuplicate(
      record({ providerEventId: "id", calendarId: "primary" }),
      record({
        providerEventId: "id",
        calendarId: "primary",
        title: "Changed title",
      }),
    )?.strength,
  ).toBe("exact_identity");
  const hashMatch = rules.compareDuplicate(
    record({ payloadHash: "hash" }),
    record({ payloadHash: "hash" }),
  );
  expect(hashMatch?.strength).toBe("strong_possible");
  expect(hashMatch?.evidence).toContain("same_commitment_hash");
  expect(
    rules.compareDuplicate(
      record({ payloadHash: "hash" }),
      record({ payloadHash: "hash", title: "Unrelated" }),
    ),
  ).toBeNull();
  expect(
    rules.compareDuplicate(
      record({ sourceIdentity: identity }),
      record({
        sourceIdentity: { ...identity, connectionId: "someone-else" },
        title: "Unrelated",
      }),
    ),
  ).toBeNull();
});
it("date-only and all-day ranges match without inventing times", () => {
  const all = {
    kind: "all_day" as const,
    startDate: "2026-10-10",
    endExclusive: "2026-10-11",
  };
  const date = {
    kind: "date_only" as const,
    startDate: "2026-10-10",
    endDateInclusive: null,
  };
  expect(
    rules.compareDuplicate(record({ temporal: all }), record({ temporal: all }))
      ?.strength,
  ).toBe("strong_possible");
  expect(
    rules.compareDuplicate(
      record({ temporal: date }),
      record({ temporal: all }),
    )?.strength,
  ).toBe("possible");
  expect(
    rules.compareDuplicate(record({ temporal: all }), record()),
  ).toBeNull();
  expect(
    rules.compareDuplicate(
      record({ temporal: all }),
      record({
        temporal: {
          ...all,
          startDate: "2026-10-17",
          endExclusive: "2026-10-18",
        },
      }),
    ),
  ).toBeNull();
});
it("invalid temporal intervals and placeholder titles do not give semantic matches", () => {
  expect(
    rules.compareDuplicate(
      record({ title: "No subject" }),
      record({ title: "No subject" }),
    ),
  ).toBeNull();
  expect(
    rules.compareDuplicate(
      record(),
      record({
        temporal: {
          ...draft.temporal,
          end: draft.temporal.kind === "timed" ? draft.temporal.start : "",
        },
      }),
    ),
  ).toBeNull();
});
it("windows are bounded, date-only keeps dates, and unresolved years remain skipped", () => {
  const w = rules.duplicateWindow(draft, "America/Chicago");
  expect(w).toMatchObject({
    timeMin: "2026-10-09T15:00:00.000Z",
    timeMax: "2026-10-11T16:00:00.000Z",
  });
  expect(
    rules.duplicateWindow(
      {
        ...draft,
        temporal: {
          kind: "unresolved",
          text: "October 20",
          timezone: "America/Chicago",
        },
      },
      "America/Chicago",
    ),
  ).toBeNull();
  expect(
    rules.duplicateWindow(
      {
        ...draft,
        temporal: {
          kind: "timed",
          start: "2026-10-10T15:00:00.000Z",
          end: "2026-12-10T15:00:00.000Z",
          timezone: "America/Chicago",
        },
      },
      "America/Chicago",
    ),
  ).toBeNull();
  expect(
    rules.duplicateWindow(
      {
        ...draft,
        temporal: {
          kind: "timed",
          start: "2026-10-10T15:00:00.000Z",
          end: "2026-10-09T15:00:00.000Z",
          timezone: "America/Chicago",
        },
      },
      "America/Chicago",
    ),
  ).toBeNull();
  const fold = rules.duplicateWindow(
    {
      ...draft,
      temporal: {
        kind: "all_day",
        startDate: "2026-11-01",
        endExclusive: "2026-11-02",
      },
    },
    "America/Chicago",
  )!;
  expect(Date.parse(fold.timeMax) - Date.parse(fold.timeMin)).toBe(
    97 * 3600000,
  );
});
it("linked local and live matches are combined while preserving independent events", () => {
  const a = rules.compareDuplicate(
    record(),
    record({
      providerEventId: "event",
      calendarId: "primary",
      reviewId: "00000000-0000-4000-8000-000000000001",
    }),
  )!;
  const b = rules.compareDuplicate(
    record(),
    record({
      source: "google",
      key: "event",
      providerEventId: "event",
      calendarId: "primary",
    }),
  )!;
  const other = rules.compareDuplicate(record(), record({ key: "different" }))!;
  const merged = rules.mergeDuplicateMatches([a, b, other]);
  expect(merged).toHaveLength(2);
  expect(merged[0].sources.sort()).toEqual(["google", "local"]);
});

it("coalesced live facts replace stale local strength and semantic reasons", () => {
  const candidate = record({ location: "Room 1" });
  const local = rules.compareDuplicate(
    candidate,
    record({
      location: "Room 1",
      providerEventId: "linked",
      calendarId: "primary",
    }),
  )!;
  const live = rules.compareDuplicate(
    candidate,
    record({
      source: "google",
      key: "google:linked",
      location: "Room 2",
      providerEventId: "linked",
      calendarId: "primary",
      temporal: {
        ...draft.temporal,
        start: "2026-10-10T15:10:00.000Z",
        end: "2026-10-10T17:10:00.000Z",
      },
    }),
  )!;
  const [merged] = rules.mergeDuplicateMatches([local, live]);
  expect(merged.strength).toBe("possible");
  expect(merged.evidence).toContain("near_start_overlap");
  expect(merged.evidence).toContain("different_location");
  expect(merged.evidence).not.toContain("same_time");
  expect(merged.evidence).not.toContain("same_location");
  expect(merged.evidence).not.toContain("same_duration");
  expect(merged.facts.location).toBe("Room 2");
});
