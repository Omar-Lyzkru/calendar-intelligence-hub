import { it, expect } from "vitest";
import { evaluateConfidence, ConfidenceReportSchema } from "./confidence.js";
import { CandidateSchema } from "./http.js";
import { evaluateDraft } from "./readiness.js";
import type { EditableEventDraft, Evidence } from "./events.js";
const draft: EditableEventDraft = {
  title: "Workshop",
  location: null,
  description: null,
  category: "event",
  temporal: {
    kind: "timed",
    start: "2026-10-20T15:00:00Z",
    end: "2026-10-20T16:00:00Z",
    timezone: "America/Chicago",
    timezoneProvenance: "explicit",
  },
};
const evidence: Evidence[] = [
  { code: "explicit_date", origin: "content", text: "October 20, 2026" },
  { code: "explicit_time", origin: "content", text: "10:00 AM" },
  { code: "event_keyword", text: "Workshop" },
];
const score = (d = draft, e = evidence) =>
  evaluateConfidence({ draft: d, evidence: e });
it("strong explicit extraction has high explainable support without a probability", () => {
  const result = score();
  expect(result.band).toBe("high");
  expect(result.signals.map((s) => s.code)).toEqual([
    "explicit_date",
    "explicit_time",
    "explicit_timezone",
    "event_wording",
    "complete_temporal",
  ]);
  expect(result).not.toHaveProperty("probability");
  expect(result).not.toHaveProperty("percent");
});
it("weak unresolved extraction has low support and visible negative signals", () => {
  const result = score(
    {
      ...draft,
      temporal: {
        kind: "unresolved",
        text: "",
        timezone: "America/Chicago",
        timezoneProvenance: "assumed",
      },
    },
    [],
  );
  expect(result.band).toBe("low");
  expect(result.signals.map((s) => s.code)).toEqual([
    "unresolved_temporal",
    "assumed_timezone",
    "weak_wording",
  ]);
});
it("repeating the same evidence cannot inflate support", () => {
  expect(score(draft, Array(100).fill(evidence).flat())).toEqual(score());
});
it("corroborating subject and body date earns a single agreement signal", () => {
  expect(
    score(draft, [
      ...evidence,
      { code: "explicit_date", origin: "subject", text: "October 20, 2026" },
    ]).signals,
  ).toContainEqual({ code: "corroborated_temporal", points: 1 });
});
it("contradictory subject and body never earn agreement", () => {
  const result = score(
    {
      ...draft,
      temporal: {
        kind: "unresolved",
        text: "",
        timezone: "America/Chicago",
        issueCodes: ["multiple_dates"],
      },
    },
    [
      ...evidence,
      { code: "explicit_date", origin: "subject", text: "October 21, 2026" },
    ],
  );
  expect(result.signals).toContainEqual({
    code: "conflicting_evidence",
    points: -3,
  });
  expect(result.signals.some((s) => s.code === "corroborated_temporal")).toBe(
    false,
  );
  expect(result.band).toBe("low");
});
it("date-only support does not invent explicit time or completeness", () => {
  const result = score({
    ...draft,
    temporal: {
      kind: "date_only",
      startDate: "2026-10-20",
      endDateInclusive: null,
    },
  });
  expect(result.signals.some((s) => s.code === "complete_temporal")).toBe(
    false,
  );
});
it("assumed timezone lowers support rather than masquerading as explicit", () => {
  const result = score({
    ...draft,
    temporal: {
      ...draft.temporal,
      timezoneProvenance: "assumed",
    } as EditableEventDraft["temporal"],
  });
  expect(result.band).toBe("medium");
  expect(result.signals).toContainEqual({
    code: "assumed_timezone",
    points: -1,
  });
});
it("high confidence never bypasses missing title readiness", () => {
  const d = { ...draft, title: "" };
  expect(score(d).band).toBe("high");
  expect(evaluateDraft(d).status).toBe("blocked");
});
it("a corrected valid draft can be ready while original support remains low", () => {
  const original = {
    ...draft,
    temporal: {
      kind: "unresolved" as const,
      text: "",
      timezone: "America/Chicago",
    },
  };
  const report = score(original, []);
  expect(report.band).toBe("low");
  expect(evaluateDraft(draft).status).toBe("ready");
  expect(report.basis).toBe("original_extraction");
});
it("ambiguous classification is explained without invalidating a valid event", () => {
  const r = evaluateConfidence({
    draft,
    evidence,
    classification: {
      version: 1,
      status: "ambiguous",
      category: "other",
      alternatives: ["meeting", "exam_quiz"],
    },
  });
  expect(r.signals).toContainEqual({ code: "ambiguous_category", points: -1 });
  expect(evaluateDraft(draft).status).toBe("ready");
});
it("legacy null and new coded report both cross the candidate boundary", () => {
  const c = {
    draft,
    evidence,
    extractionVersion: 2,
    missingFields: [],
    validationIssues: [],
  };
  expect(CandidateSchema.safeParse({ ...c, confidence: null }).success).toBe(
    true,
  );
  expect(CandidateSchema.safeParse({ ...c, confidence: score() }).success).toBe(
    true,
  );
});
it("forged bands, weights, repeated signals and text payloads are rejected", () => {
  const r = score();
  for (const bad of [
    { ...r, band: "low" },
    { ...r, signals: [{ code: "explicit_date", points: 99 }] },
    { ...r, signals: [...r.signals, r.signals[0]] },
    { ...r, rawBody: "private" },
  ])
    expect(ConfidenceReportSchema.safeParse(bad).success).toBe(false);
});
