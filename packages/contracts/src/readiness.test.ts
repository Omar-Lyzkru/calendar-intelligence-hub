import { it, expect } from "vitest";
import {
  EventDraftSchema,
  ReadyEventSchema,
  validateReadyEvent,
  EditableEventDraftSchema,
} from "./events.js";
import { evaluateDraft, deriveReviewState } from "./readiness.js";
const timed = {
  title: "Workshop",
  location: null,
  description: null,
  category: "event" as const,
  temporal: {
    kind: "timed" as const,
    start: "2026-10-08T19:00:00.123Z",
    end: "2026-10-08T20:00:00.123Z",
    timezone: "America/Chicago",
  },
};
it.each([
  "",
  "   ",
  "No subject",
  " (NO SUBJECT) ",
  "Event needing review",
  "Untitled candidate",
  "Untitled message",
])("mutable title %j cannot approve but remains editable", (title) => {
  const draft = { ...timed, title };
  expect(EditableEventDraftSchema.safeParse(draft).success).toBe(true);
  const e = evaluateDraft(draft);
  expect(e.status).toBe("blocked");
  expect(e.blockers.map((b) => b.code)).toEqual(["title_required"]);
  expect(e.missingFields).toEqual(["title"]);
  expect(deriveReviewState("needs_review", e, null).actions).toMatchObject({
    edit: true,
    ignore: true,
    approve: false,
  });
});
it("strict schemas and immutable legacy fallback title stay compatible", () => {
  expect(EventDraftSchema.safeParse({ ...timed, title: "" }).success).toBe(
    false,
  );
  expect(ReadyEventSchema.safeParse({ ...timed, title: "" }).success).toBe(
    false,
  );
  const old = { ...timed, title: "Event needing review" };
  expect(validateReadyEvent(old).ok).toBe(true);
  expect(evaluateDraft(old, { legacyTitle: true }).status).toBe("ready");
});
it("simultaneous blockers derive readiness and missing fields without mutating input", () => {
  const draft = {
    ...timed,
    title: "",
    temporal: {
      kind: "date_only",
      startDate: "2026-10-20",
      endDateInclusive: null,
    },
  };
  const before = JSON.stringify(draft);
  const e = evaluateDraft(draft);
  expect(e.blockers.map((b) => b.code)).toEqual([
    "title_required",
    "date_only_unconfirmed",
  ]);
  expect(e.missingFields).toEqual(["title"]);
  expect(JSON.stringify(draft)).toBe(before);
  expect(evaluateDraft({ ...timed, title: "Corrected" }).blockers).toEqual([]);
});
it("optional empty details do not block and missing end uses Phase2A code", () => {
  expect(
    evaluateDraft({ ...timed, location: "", description: "" }).status,
  ).toBe("ready");
  expect(
    evaluateDraft({
      ...timed,
      title: "",
      temporal: { ...timed.temporal, end: null },
    }).blockers.map((b) => b.code),
  ).toEqual(["title_required", "end_required"]);
});
it("unresolved evidence gives safe detailed blockers, unknown text never becomes a message", () => {
  const e = evaluateDraft({
    ...timed,
    temporal: {
      kind: "unresolved",
      text: "PRIVATE-SENTINEL",
      timezone: "America/Chicago",
      partial: { month: 10, day: 20 },
      issueCodes: ["unresolved_timezone", "PRIVATE-SENTINEL"],
    },
  });
  expect(e.blockers.map((b) => b.code)).toContain("year_required");
  expect(e.blockers.map((b) => b.code)).toContain("unresolved_timezone");
  expect(JSON.stringify(e)).not.toContain("PRIVATE-SENTINEL");
  expect(e.status).toBe("blocked");
});
it("conversion blockers use fixed code messages and cannot be bypassed by otherwise ready values", () => {
  const e = evaluateDraft(timed, {
    conversionIssues: [
      {
        field: "temporal.start",
        code: "nonexistent_time",
        message: "PRIVATE-SENTINEL",
      },
    ],
  });
  expect(e.status).toBe("blocked");
  expect(JSON.stringify(e)).not.toContain("PRIVATE-SENTINEL");
});
it("approval is workflow gated even when validity is ready", () => {
  const e = evaluateDraft(timed);
  expect(deriveReviewState("ignored", e, null)).toMatchObject({
    workflow: { phase: "ignored" },
    actions: { edit: false, ignore: false, approve: false, write: false },
  });
  expect(deriveReviewState("approved", e, null)).toMatchObject({
    workflow: { phase: "approved" },
    actions: { approve: false, write: true },
  });
  expect(
    deriveReviewState(
      "writing",
      e,
      { status: "writing" },
      { leaseActive: true },
    ).actions,
  ).toMatchObject({ write: false, refresh: true });
  expect(
    deriveReviewState(
      "writing",
      e,
      { status: "writing" },
      { leaseActive: false },
    ).actions.write,
  ).toBe(true);
  expect(deriveReviewState("added", e, { status: "added" }).actions.write).toBe(
    false,
  );
  expect(
    deriveReviewState("approved", e, {
      status: "unknown",
      reason: "provider_timeout",
    }).actions.write,
  ).toBe(true);
  expect(
    deriveReviewState("approved", e, {
      status: "failed",
      reason: "event_mismatch",
    }).actions.write,
  ).toBe(false);
  expect(
    deriveReviewState("approved", e, null, { integrityValid: false }).actions
      .write,
  ).toBe(false);
});

it.each(["toString", "constructor", "__proto__"])(
  "inherited extraction issue code %s cannot corrupt blockers",
  (code) => {
    const result = evaluateDraft({
      ...timed,
      temporal: {
        kind: "unresolved",
        text: "",
        timezone: "America/Chicago",
        partial: { startClock: "14:00" },
        issueCodes: [code],
      },
    });
    expect(result.status).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toEqual(["unresolved_time"]);
    expect(result.blockers.every((b) => typeof b.message === "string")).toBe(
      true,
    );
  },
);
