import { it, expect } from "vitest";
import { processMessage } from "../../application/processMessage.js";
import { validateEvent } from "./validate.js";
import type { NormalizedMessage } from "@hub/contracts";
const message = (content: string): NormalizedMessage => ({
  id: "id",
  userId: "u",
  sourceConnectionId: "c",
  source: "gmail",
  externalId: "e",
  content,
  subject: "Workshop",
  receivedAt: "2026-10-07T12:00:00Z",
  ingestedAt: "2026-10-07T12:00:00Z",
  normalizationVersion: 1,
});
it("explicit_meeting_requires_review", () => {
  const r = processMessage(
    message("Workshop October 8, 2026 at 2:00 PM"),
    "America/Chicago",
  );
  expect(r.kind).toBe("review");
  if (r.kind === "review") {
    expect(r.candidate.draft.temporal).toEqual({
      kind: "timed",
      start: "2026-10-08T19:00:00.000Z",
      end: null,
      timezone: "America/Chicago",
      timezoneProvenance: "assumed",
    });
    expect(r.candidate.missingFields).toContain("end");
    expect(r.candidate.confidence).toMatchObject({
      version: 1,
      basis: "original_extraction",
      band: "medium",
    });
  }
});
it("newsletter_date_is_no_event", () => {
  expect(
    processMessage(
      { ...message("Newsletter October 8, 2026"), subject: "News" },
      "America/Chicago",
    ).kind,
  ).toBe("no_event");
});
it.each([
  "Meeting soon",
  "Workshop October 8 at 2:00 PM",
  "Meeting 10/08/2026 at 2:00 PM",
  "Meeting October 8, 2026 and October 9, 2026 at 2:00 PM",
  "Meeting cancelled October 8, 2026 at 2:00 PM",
  "Meeting next Friday at 2:00 PM",
])("ambiguous_input_is_unresolved: %s", (text) => {
  const r = processMessage(message(text), "America/Chicago");
  expect(r.kind).toBe("review");
  if (r.kind === "review")
    expect(r.candidate.draft.temporal.kind).toBe("unresolved");
});
it.each([
  "Meeting March 8, 2026 at 2:30 AM",
  "Meeting November 1, 2026 at 1:30 AM",
])("dst_gap_and_fold_require_resolution: %s", (text) => {
  const r = processMessage(message(text), "America/Chicago");
  if (r.kind !== "review") throw Error("missing review");
  expect(r.candidate.draft.temporal.kind).toBe("unresolved");
});
it("invalid_end_is_rejected", () => {
  expect(
    validateEvent({
      title: "Exam",
      location: null,
      description: null,
      category: "event",
      temporal: {
        kind: "timed",
        start: "2026-10-08T19:00:00Z",
        end: "2026-10-08T18:00:00Z",
        timezone: "America/Chicago",
      },
    }).ok,
  ).toBe(false);
});
it("all_day_end_is_exclusive", () => {
  expect(
    validateEvent({
      title: "Exam",
      location: null,
      description: null,
      category: "event",
      temporal: {
        kind: "all_day",
        startDate: "2026-10-08",
        endExclusive: "2026-10-08",
      },
    }).ok,
  ).toBe(false);
  expect(
    validateEvent({
      title: "Exam",
      location: null,
      description: null,
      category: "event",
      temporal: {
        kind: "all_day",
        startDate: "2026-10-08",
        endExclusive: "2026-10-09",
      },
    }).ok,
  ).toBe(true);
});

it.each([
  ["Workshop October 20, 2026 at 2:30 PM–4:00 PM", "timed"],
  ["Workshop 10/20/2026 2:30–4:00 PM", "timed"],
  ["Workshop October 20, 2026", "date_only"],
  ["Workshop October 20, 2026 through October 22, 2026", "date_only"],
  ["Workshop Tuesday, October 20 from 2:30–4:00 PM", "unresolved"],
  ["Workshop October 20, 2026 at 2:30 PM CST", "unresolved"],
  ["Workshop October 20, 2026 from 11–1 PM", "unresolved"],
  ["Workshop October 20, 2026 at 2:30 PM America/Chicago CDT", "timed"],
  ["Workshop October 20, 2026 at 2:30 PM America/Chicago CST", "unresolved"],
  [
    "Workshop December 31, 2026 at 11:30 PM to January 1, 2027 at 12:15 AM",
    "timed",
  ],
])("phase2a conservatively processes %s", (text, kind) => {
  const r = processMessage(message(text), "America/Chicago");
  expect(r.kind).toBe("review");
  if (r.kind === "review") expect(r.candidate.draft.temporal.kind).toBe(kind);
});
it("extracts subject timing, deduplicates source facts, and preserves explicit zone", () => {
  const text = "Workshop October 20, 2026 at 3:00 PM Eastern Time";
  const r = processMessage(
    { ...message(text), subject: text },
    "America/Chicago",
  );
  if (r.kind !== "review") throw Error();
  expect(r.candidate.draft.temporal).toMatchObject({
    kind: "timed",
    start: "2026-10-20T19:00:00.000Z",
    timezone: "America/New_York",
    timezoneProvenance: "explicit",
  });
  expect(r.candidate.extractionVersion).toBe(2);
  expect(r.candidate.evidence.some((e) => e.origin === "subject")).toBe(true);
  const subjectOnly = processMessage(
    {
      ...message("Details attached."),
      subject: "Workshop Oct 9, 2026 2:30pm - 3:15pm",
    },
    "America/Chicago",
  );
  if (subjectOnly.kind !== "review") throw Error();
  expect(subjectOnly.candidate.draft.temporal).toMatchObject({
    kind: "timed",
    start: "2026-10-09T19:30:00.000Z",
    end: "2026-10-09T20:15:00.000Z",
  });
});
it.each([
  "Meeting October 20, 2026 at 2 PM and October 21, 2026 at 3 PM. Remember to bring notes.",
  "Meeting Wednesday 2026-10-20 at 14:30",
  "Meeting Wednesday 10/20/2026 at 14:30",
  "Meeting October 20, 2026 at 14:30 IST",
  "Meeting October 20, 2026 at 2 PM XYZ America/Chicago",
  "Meeting October 20, 2026 at 2 PM cst",
])(
  "review regression: conflicting or unsupported evidence stays unresolved: %s",
  (text) => {
    const r = processMessage(message(text), "America/Chicago");
    if (r.kind !== "review") throw Error();
    expect(r.candidate.draft.temporal.kind).toBe("unresolved");
  },
);
it.each([
  "Meeting October 20, 2026. Read John 3:16 and Romans 8:28.",
  "Meeting October 20, 2026 at 14:00 or 15:00",
  "Meeting October 20, 2026 and October 21, 2026. Remember to bring notes.",
  "Meeting October 20, 2026 at 14:00–15:00 AEST",
])(
  "review regression: unrelated tokens cannot form an interval: %s",
  (text) => {
    const r = processMessage(message(text), "America/Chicago");
    if (r.kind !== "review") throw Error();
    expect(r.candidate.draft.temporal.kind).not.toBe("timed");
    if (text.includes("Remember"))
      expect(r.candidate.draft.temporal.kind).toBe("unresolved");
  },
);
it("subject start and matching body range merge without conflict", () => {
  const r = processMessage(
    {
      ...message("Meeting October 20, 2026 at 14:00–15:00"),
      subject: "Meeting October 20, 2026 at 14:00",
    },
    "America/Chicago",
  );
  if (r.kind !== "review") throw Error();
  expect(r.candidate.draft.temporal).toMatchObject({
    kind: "timed",
    start: "2026-10-20T19:00:00.000Z",
    end: "2026-10-20T20:00:00.000Z",
  });
});
it.each([
  "Japan Standard Time",
  "aest",
  "British Summer Time",
  "weekly",
  "daily",
  "monthly",
  "annually",
  "has been updated",
  "tomorrow",
  "this Friday",
])(
  "acceptance review: unsupported or contextual qualifier blocks readiness: %s",
  (qualifier) => {
    const r = processMessage(
      message(`Meeting October 20, 2026 at 2 PM to 3 PM ${qualifier}`),
      "America/Chicago",
    );
    if (r.kind !== "review") throw Error("Expected review");
    expect(r.candidate.draft.temporal.kind).toBe("unresolved");
    if (r.candidate.draft.temporal.kind !== "unresolved")
      throw Error("Expected unresolved");
    expect(r.candidate.draft.temporal.issueCodes).toContain(
      ["Japan Standard Time", "aest", "British Summer Time"].includes(qualifier)
        ? "unresolved_timezone"
        : "ambiguous_commitment",
    );
    expect(validateEvent(r.candidate.draft).ok).toBe(false);
  },
);

it.each(["", "No subject", "(no subject)", "Event needing review"])(
  "new fallback subject %s does not manufacture a usable title",
  (subject) => {
    const result = processMessage(
      { ...message("Workshop October 20, 2026"), subject },
      "America/Chicago",
    );
    expect(result.kind).toBe("review");
    if (result.kind === "review") expect(result.candidate.draft.title).toBe("");
  },
);
it("contradictory zones cannot earn corroboration from repeated date and time", () => {
  const text = "Workshop October 20, 2026 at 10:00 AM to 11:00 AM Central Time";
  const result = processMessage(
    { ...message(text + " and Pacific Time"), subject: text },
    "America/Chicago",
  );
  expect(result.kind).toBe("review");
  if (result.kind !== "review") throw Error("Expected review");
  expect(result.candidate.draft.temporal.kind).toBe("unresolved");
  expect(result.candidate.confidence?.signals).toContainEqual({
    code: "conflicting_evidence",
    points: -3,
  });
  expect(
    result.candidate.confidence?.signals.some(
      (s) => s.code === "corroborated_temporal",
    ),
  ).toBe(false);
  expect(result.candidate.confidence?.band).toBe("low");
});
