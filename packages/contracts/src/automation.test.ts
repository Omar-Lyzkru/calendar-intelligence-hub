import { it, expect } from "vitest";
import {
  evaluateAutomation,
  AutomationPolicyInputSchema,
  QuestionAnswerSchema,
} from "./automation.js";
const draft = {
  title: "Exam October 20, 2026",
  category: "event",
  eventCategory: "exam_quiz",
  location: null,
  description: null,
  temporal: {
    kind: "timed",
    start: "2026-10-20T19:00:00.000Z",
    end: "2026-10-20T20:00:00.000Z",
    timezone: "America/Chicago",
    timezoneProvenance: "explicit",
  },
};
const base: any = {
  policy: {
    enabled: true,
    rules: [
      {
        connectionId: "80000000-0000-4000-8000-000000000001",
        category: "exam_quiz",
        action: "auto",
      },
    ],
    pollGmail: false,
  },
  review: {
    revision: 1,
    status: "needs_review",
    draft,
    candidate: {
      draft,
      validationIssues: [],
      evidence: [{ code: "explicit_date" }, { code: "explicit_time" }],
      classification: {
        status: "classified",
        category: "exam_quiz",
        alternatives: [],
      },
    },
    source: { notice: undefined },
  },
  source: {
    connectionId: "80000000-0000-4000-8000-000000000001",
    connected: true,
    eligible: true,
  },
  checks: {
    local: { status: "checked" },
    google: { status: "checked" },
    matches: [],
    truncated: false,
    conflicts: {
      local: { status: "checked" },
      google: { status: "checked" },
      matches: [],
      truncated: false,
    },
  },
  confirmedFields: [],
};
const context = () => structuredClone(base);
it("explicit valid commitment with opt-in rule and complete clear coverage qualifies", () =>
  expect(evaluateAutomation(context())).toMatchObject({
    decision: "auto_handle",
    reason: "eligible",
  }));
it.each([
  ["disabled", "blocked", "automation_disabled"],
  ["historical", "blocked", "historical"],
  ["disconnected", "blocked", "source_unavailable"],
  ["changed", "ask_user", "source_changed"],
  ["added", "skip", "already_added"],
  ["skip", "skip", "category_skipped"],
  ["untrusted", "ask_user", "source_untrusted"],
  ["title", "ask_user", "title_required"],
  ["date", "ask_user", "date_required"],
  ["end", "ask_user", "time_required"],
  ["assumed", "ask_user", "timezone_confirmation"],
  ["ambiguous_category", "ask_user", "category_ambiguous"],
  ["duplicate_unavailable", "blocked", "checks_unavailable"],
  ["conflict_partial", "blocked", "checks_unavailable"],
  ["truncated", "blocked", "checks_unavailable"],
  ["possible", "ask_user", "possible_duplicate"],
  ["conflict", "ask_user", "scheduling_conflict"],
  ["exact", "blocked", "protected_identity"],
  ["inferred", "ask_user", "facts_confirmation"],
])("%s cannot authorize a write", (kind, decision, reason) => {
  const c = context();
  if (kind === "disabled") c.policy.enabled = false;
  if (kind === "historical") c.source.eligible = false;
  if (kind === "disconnected") c.source.connected = false;
  if (kind === "changed")
    c.review.source.notice = { requiresConfirmation: true };
  if (kind === "added") c.review.status = "added";
  if (kind === "skip") c.policy.rules[0].action = "skip";
  if (kind === "untrusted") c.policy.rules = [];
  if (kind === "title") c.review.draft.title = "";
  if (kind === "date")
    c.review.draft.temporal = {
      kind: "unresolved",
      text: "",
      timezone: "America/Chicago",
    };
  if (kind === "end") c.review.draft.temporal.end = null;
  if (kind === "assumed") {
    c.review.draft.temporal.timezoneProvenance = "assumed";
    c.review.candidate.draft.temporal.timezoneProvenance = "assumed";
  }
  if (kind === "ambiguous_category")
    c.review.candidate.classification.status = "ambiguous";
  if (kind === "duplicate_unavailable") c.checks.google.status = "unavailable";
  if (kind === "conflict_partial") c.checks.conflicts.local.status = "partial";
  if (kind === "truncated") c.checks.truncated = true;
  if (kind === "possible") c.checks.matches = [{ strength: "possible" }];
  if (kind === "exact") c.checks.matches = [{ strength: "exact_identity" }];
  if (kind === "conflict")
    c.checks.conflicts.matches = [{ kind: "timed_overlap" }];
  if (kind === "inferred") c.review.candidate.evidence = [];
  expect(evaluateAutomation(c)).toMatchObject({ decision, reason });
});
it("confidence cannot bypass checks or provenance", () => {
  const c = context();
  c.review.candidate.confidence = { band: "high" };
  c.checks.google.status = "unavailable";
  expect(evaluateAutomation(c).decision).toBe("blocked");
});
it("explicit confirmation permits corrected temporal facts, never missing facts", () => {
  const c = context();
  c.review.candidate.evidence = [];
  c.confirmedFields = ["temporal"];
  expect(evaluateAutomation(c).decision).toBe("auto_handle");
  c.review.draft.temporal.end = null;
  expect(evaluateAutomation(c).reason).toBe("time_required");
});
it("most conservative matching rule wins independently of rule order", () => {
  const c = context();
  c.policy.rules.push({ ...c.policy.rules[0], action: "ask" });
  expect(evaluateAutomation(c).reason).toBe("source_untrusted");
  c.policy.rules.reverse();
  expect(evaluateAutomation(c).reason).toBe("source_untrusted");
});
it("Discord channel rule cannot authorize a different channel", () => {
  const c = context();
  c.policy.rules[0].channelId = "800000000000000001";
  c.source.channelId = "800000000000000002";
  expect(evaluateAutomation(c).reason).toBe("source_untrusted");
});
it("rules and answers reject private or unrelated fields", () => {
  expect(
    AutomationPolicyInputSchema.safeParse({
      enabled: true,
      pollGmail: false,
      rules: [],
      token: "private",
    }).success,
  ).toBe(false);
  expect(
    QuestionAnswerSchema.safeParse({
      kind: "title",
      value: "Exam",
      description: "unrequested",
    }).success,
  ).toBe(false);
});
it("a one-time user authorization remains distinct from autonomous eligibility", () => {
  const c = context();
  c.policy.rules[0].action = "ask";
  c.confirmedFields = ["permission"];
  expect(evaluateAutomation(c)).toMatchObject({
    decision: "auto_handle",
    reason: "user_authorized",
  });
  c.policy.rules[0].action = "skip";
  expect(evaluateAutomation(c).decision).toBe("skip");
});
it("placeholder titles ask for a title rather than entering a time-question loop", () => {
  const c = context();
  c.review.draft.title = "Untitled candidate";
  expect(evaluateAutomation(c)).toMatchObject({
    decision: "ask_user",
    reason: "title_required",
  });
});
