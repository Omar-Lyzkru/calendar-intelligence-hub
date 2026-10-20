import { it, expect } from "vitest";
import {
  EventCategorySchema,
  EVENT_CATEGORY_LABELS,
  ClassificationSchema,
} from "./categories.js";
import { EditableEventDraftSchema, ReadyEventSchema } from "./events.js";
import { CandidateSchema } from "./http.js";
import { evaluateDraft } from "./readiness.js";
const ready = {
  title: "Synthetic Workshop",
  location: null,
  description: null,
  category: "event",
  temporal: {
    kind: "all_day",
    startDate: "2026-10-20",
    endExclusive: "2026-10-21",
  },
};
it("all roadmap categories have stable codes and human labels", () => {
  expect(EventCategorySchema.options).toEqual([
    "academic_deadline",
    "exam_quiz",
    "class_academic",
    "career",
    "club_organization",
    "social",
    "meeting",
    "appointment",
    "registration_deadline",
    "hackathon_workshop",
    "other",
  ]);
  expect(Object.keys(EVENT_CATEGORY_LABELS)).toEqual(
    EventCategorySchema.options,
  );
  for (const label of Object.values(EVENT_CATEGORY_LABELS))
    expect(label.length).toBeGreaterThan(3);
  expect(EventCategorySchema.safeParse("confidence_high").success).toBe(false);
});
it("legacy drafts, approved snapshots and candidates retain absent metadata", () => {
  expect(EditableEventDraftSchema.parse(ready)).toEqual(ready);
  expect(JSON.stringify(ReadyEventSchema.parse(ready))).toBe(
    JSON.stringify(ready),
  );
  const candidate = {
    draft: ready,
    missingFields: [],
    validationIssues: [],
    evidence: [],
    extractionVersion: 2,
    confidence: null,
  };
  expect(CandidateSchema.parse(candidate)).toEqual(candidate);
});
it("category metadata survives contracts but cannot bypass title or temporal readiness", () => {
  const draft = { ...ready, eventCategory: "other" };
  expect(ReadyEventSchema.parse(draft)).toEqual(draft);
  expect(evaluateDraft(draft).status).toBe("ready");
  expect(evaluateDraft({ ...draft, title: "" }).status).toBe("blocked");
  expect(
    evaluateDraft({
      ...draft,
      temporal: {
        kind: "date_only",
        startDate: "2026-10-20",
        endDateInclusive: null,
      },
    }).status,
  ).toBe("blocked");
  expect(
    EditableEventDraftSchema.safeParse({ ...draft, eventCategory: "invented" })
      .success,
  ).toBe(false);
});
it("classification allows bounded consistent summaries and rejects contradictory/private fields", () => {
  const classified = {
    version: 1,
    status: "classified",
    category: "career",
    alternatives: [],
  };
  const ambiguous = {
    version: 1,
    status: "ambiguous",
    category: "other",
    alternatives: ["career", "meeting"],
  };
  expect(ClassificationSchema.parse(classified)).toEqual(classified);
  expect(ClassificationSchema.parse(ambiguous)).toEqual(ambiguous);
  expect(
    ClassificationSchema.parse({
      version: 1,
      status: "other",
      category: "other",
      alternatives: [],
    }),
  ).toBeTruthy();
  for (const invalid of [
    { ...classified, category: "other" },
    { ...classified, alternatives: ["meeting"] },
    { ...ambiguous, alternatives: ["career"] },
    { ...ambiguous, alternatives: ["career", "career"] },
    { ...ambiguous, category: "meeting" },
    { ...classified, version: 2 },
    { ...classified, text: "PRIVATE-SOURCE" },
    { ...ambiguous, alternatives: ["other", "meeting"] },
  ])
    expect(ClassificationSchema.safeParse(invalid).success).toBe(false);
});
