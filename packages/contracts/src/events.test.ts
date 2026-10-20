import { it, expect } from "vitest";
import { ReadyEventSchema } from "./events.js";
it("event_contract_rejects_unresolved_ready_event", () => {
  expect(
    ReadyEventSchema.safeParse({
      title: "Meeting",
      temporal: { kind: "unresolved" },
    }).success,
  ).toBe(false);
});

it("mixed_fractional_precision_cannot_create_negative_duration", () => {
  expect(
    ReadyEventSchema.safeParse({
      title: "Exam",
      location: null,
      description: null,
      category: "event",
      temporal: {
        kind: "timed",
        start: "2026-10-08T19:00:00.500Z",
        end: "2026-10-08T19:00:00Z",
        timezone: "America/Chicago",
      },
    }).success,
  ).toBe(false);
});
it("mixed_fractional_precision_cannot_create_zero_duration", () => {
  expect(
    ReadyEventSchema.safeParse({
      title: "Exam",
      location: null,
      description: null,
      category: "event",
      temporal: {
        kind: "timed",
        start: "2026-10-08T19:00:00.000Z",
        end: "2026-10-08T19:00:00Z",
        timezone: "America/Chicago",
      },
    }).success,
  ).toBe(false);
});

import { EventDraftSchema, validateReadyEvent } from "./events.js";
it("date_only_is_structured_but_never_ready_and_legacy_provenance_is_not_guessed", () => {
  const base = {
    title: "Deadline",
    location: null,
    description: null,
    category: "deadline",
  };
  const draft = {
    ...base,
    temporal: {
      kind: "date_only",
      startDate: "2026-10-20",
      endDateInclusive: null,
    },
  };
  expect(EventDraftSchema.safeParse(draft).success).toBe(true);
  expect(validateReadyEvent(draft).ok).toBe(false);
  const old = {
    ...base,
    temporal: {
      kind: "timed",
      start: "2026-10-20T19:00:00Z",
      end: "2026-10-20T20:00:00Z",
      timezone: "America/Chicago",
    },
  };
  expect(EventDraftSchema.parse(old).temporal).not.toHaveProperty(
    "timezoneProvenance",
  );
});
it("shared_schema_and_domain_reject_impossible_dates_and_explain_missing_end", () => {
  const base = {
    title: "Workshop",
    location: null,
    description: null,
    category: "event",
  };
  const invalid = {
    ...base,
    temporal: {
      kind: "all_day",
      startDate: "2026-02-30",
      endExclusive: "2026-03-03",
    },
  };
  expect(ReadyEventSchema.safeParse(invalid).success).toBe(false);
  expect(validateReadyEvent(invalid).ok).toBe(false);
  expect(
    validateReadyEvent({
      ...base,
      temporal: {
        kind: "timed",
        start: "2026-10-20T19:00:00Z",
        end: null,
        timezone: "America/Chicago",
      },
    }),
  ).toMatchObject({ ok: false, issues: [{ code: "end_required" }] });
});
