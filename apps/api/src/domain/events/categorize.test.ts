import { it, expect } from "vitest";
import { categorize } from "./categorize.js";
import { processMessage } from "../../application/processMessage.js";
import {
  ClassificationSchema,
  EventCategorySchema,
  type NormalizedMessage,
  type EventCategory,
} from "@hub/contracts";
const message = (subject: string, content = ""): NormalizedMessage => ({
  id: "id",
  userId: "u",
  sourceConnectionId: "c",
  source: "gmail",
  externalId: "e",
  subject,
  content,
  receivedAt: "2026-10-07T12:00:00Z",
  ingestedAt: "2026-10-07T12:00:00Z",
  normalizationVersion: 1,
});
it.each<[string, EventCategory]>([
  ["Assignment due", "academic_deadline"],
  ["Homework deadline", "academic_deadline"],
  ["Project submission deadline", "academic_deadline"],
  ["Paper due", "academic_deadline"],
  ["EXAM", "exam_quiz"],
  ["Quiz", "exam_quiz"],
  ["Midterm", "exam_quiz"],
  ["Final exam", "exam_quiz"],
  ["Guest lecture", "class_academic"],
  ["Class session", "class_academic"],
  ["Academic seminar", "class_academic"],
  ["Career fair", "career"],
  ["Job interview", "career"],
  ["Recruitment event", "career"],
  ["Networking event", "career"],
  ["Club meeting", "club_organization"],
  ["Organization event", "club_organization"],
  ["Party", "social"],
  ["Social gathering", "social"],
  ["Mixer", "social"],
  ["Team meeting", "meeting"],
  ["Doctor appointment", "appointment"],
  ["Registration deadline", "registration_deadline"],
  ["Enrollment closes", "registration_deadline"],
  ["Signup due", "registration_deadline"],
  ["Hackathon", "hackathon_workshop"],
  ["Workshop", "hackathon_workshop"],
])("classifies explicit %s as %s", (text, category) => {
  const result = categorize(message(text));
  expect(result.classification).toEqual({
    version: 1,
    status: "classified",
    category,
    alternatives: [],
  });
  expect(ClassificationSchema.safeParse(result.classification).success).toBe(
    true,
  );
  expect(
    result.evidence.some((e) => e.code === "category_keyword_" + category),
  ).toBe(true);
});
it("specific contained meeting is consumed but independent meeting remains ambiguous", () => {
  expect(categorize(message("Club meeting")).classification.category).toBe(
    "club_organization",
  );
  expect(
    categorize(message("Club meeting and a team meeting")).classification,
  ).toEqual({
    version: 1,
    status: "ambiguous",
    category: "other",
    alternatives: ["club_organization", "meeting"],
  });
});
it("agreement deduplicates while subject/body disagreement remains stable and exposed", () => {
  expect(
    categorize(message("Workshop", "Workshop details")).classification.status,
  ).toBe("classified");
  const result = categorize(message("Appointment", "Exam details"));
  expect(result.classification).toEqual({
    version: 1,
    status: "ambiguous",
    category: "other",
    alternatives: ["exam_quiz", "appointment"],
  });
  expect(
    categorize(message("Exam details", "Appointment")).classification,
  ).toEqual(result.classification);
});
it("evidence is local to its origin with exact spans and bounded across repeated hits", () => {
  const input = message("A club meeting", "Please attend our Workshop.");
  for (const e of categorize(input).evidence) {
    expect(e.origin).toMatch(/subject|content/);
    const source = e.origin === "subject" ? input.subject! : input.content;
    expect(source.slice(e.start, e.end)).toBe(e.text);
  }
  const repeated = message(
    "Exam ".repeat(100),
    "Workshop ".repeat(100) + "Appointment",
  );
  const result = categorize(repeated);
  expect(
    result.evidence.filter((e) => e.code === "category_keyword_exam_quiz"),
  ).toHaveLength(2);
  expect(
    result.evidence.filter(
      (e) => e.code === "category_keyword_hackathon_workshop",
    ),
  ).toHaveLength(2);
  expect(result.classification.alternatives).toContain("appointment");
  const all = EventCategorySchema.options.filter((c) => c !== "other");
  const content =
    "Assignment due Exam Lecture Career fair Club meeting Party Meeting Appointment Registration deadline Workshop ".repeat(
      10,
    );
  const bounded = categorize(message(content, content));
  expect(bounded.evidence.length).toBeLessThanOrEqual(40);
  expect(bounded.classification.alternatives).toEqual(all);
});
it.each([
  "Newsletter",
  "Department news: class schedules",
  "career guidance",
  "Due date",
  "Registration",
  "examiner",
  "quizzical",
  "meetinghouse",
  "partygoer",
])("unsupported wording stays other: %s", (text) => {
  expect(categorize(message(text)).classification).toEqual({
    version: 1,
    status: "other",
    category: "other",
    alternatives: [],
  });
});
it("categories depend on lexical evidence, not validity, source identity or timestamps", () => {
  const a = message("Cancelled exam", "October 20, 2026");
  const b = { ...a, receivedAt: "2000-01-01T00:00:00Z", externalId: "x" };
  expect(categorize(a)).toEqual(categorize(b));
  expect(categorize(a).classification.category).toBe("exam_quiz");
  const r = processMessage(a, "America/Chicago");
  expect(r.kind).toBe("review");
  if (r.kind === "review")
    expect(r.candidate.draft.temporal.kind).toBe("unresolved");
});
it.each([
  "Lecture",
  "Class session",
  "Club meeting",
  "Party",
  "Mixer",
  "Midterm",
  "Paper due",
  "Enrollment closes",
])("new specific category signal enters conservative review: %s", (text) => {
  const r = processMessage(
    message(text, "October 20, 2026"),
    "America/Chicago",
  );
  expect(r.kind).toBe("review");
  if (r.kind === "review") {
    expect(r.candidate.classification).toEqual(
      categorize(message(text, "October 20, 2026")).classification,
    );
    expect(r.candidate.draft.eventCategory).toBe(
      r.candidate.classification?.category,
    );
    expect(r.candidate.draft.temporal.kind).toBe("date_only");
    expect(r.candidate.confidence).toMatchObject({
      version: 1,
      basis: "original_extraction",
      band: "medium",
    });
  }
});
it.each([
  "News about class schedules",
  "Our organization reports quarterly",
  "Social media tips",
  "Career guidance",
  "Research paper archive",
])("ordinary newsletter remains no_event: %s", (text) => {
  expect(
    processMessage(message(text, "October 20, 2026"), "America/Chicago").kind,
  ).toBe("no_event");
});
it("unknown generic event remains other without changed legacy category", () => {
  const result = processMessage(
    message("Event", "October 20, 2026"),
    "America/Chicago",
  );
  if (result.kind !== "review") throw Error("Expected candidate");
  expect(result.candidate.draft.category).toBe("event");
  expect(result.candidate.draft.eventCategory).toBe("other");
  expect(result.candidate.extractionVersion).toBe(2);
});

it.each<[string, EventCategory]>([
  ["Your assignment is due October 20, 2026", "academic_deadline"],
  ["Assignments are due October 20, 2026", "academic_deadline"],
  ["Homework is due on October 20, 2026", "academic_deadline"],
  ["Project submissions are due October 20, 2026", "academic_deadline"],
  ["Registration is due October 20, 2026", "registration_deadline"],
  ["Enrollment will close October 20, 2026", "registration_deadline"],
])(
  "review regression: bounded deadline grammar %s remains explicit",
  (text, category) => {
    expect(categorize(message(text)).classification).toEqual({
      version: 1,
      status: "classified",
      category,
      alternatives: [],
    });
  },
);
it("review regression: deadline in body cannot be hidden by a workshop subject", () => {
  expect(
    categorize(message("Workshop", "Your assignment is due October 20, 2026"))
      .classification,
  ).toEqual({
    version: 1,
    status: "ambiguous",
    category: "other",
    alternatives: ["academic_deadline", "hackathon_workshop"],
  });
  expect(
    categorize(message("Workshop", "Registration is due October 20, 2026"))
      .classification.alternatives,
  ).toEqual(["registration_deadline", "hackathon_workshop"]);
  expect(
    categorize(
      message("Assignment received. This is due to a change in policy."),
    ).classification.status,
  ).toBe("other");
});
it.each([
  "Third-party privacy policy update",
  "Third party integrations",
  "Third parties handle data",
  "Third-parties support",
])("review regression: ordinary %s notice is not a social event", (subject) => {
  const input = message(subject, "Review the changes to our data policy.");
  expect(categorize(input).classification.status).toBe("other");
  expect(processMessage(input, "America/Chicago").kind).toBe("no_event");
});
it("review regression: third-party token suppression preserves an independent real party", () => {
  const input = message(
    "Third-party services",
    "Third parties assist with the office party October 20, 2026",
  );
  const result = categorize(input);
  expect(result.classification.category).toBe("social");
  expect(result.evidence).toHaveLength(1);
  expect(result.evidence[0].text).toBe("party");
  expect(
    input.content.slice(result.evidence[0].start, result.evidence[0].end),
  ).toBe("party");
});
it("review regression: accepted-size repeated compounds retain bounded evidence and late independent signals", () => {
  const input = message(
    "Synthetic bulletin",
    "club meetings ".repeat(18000) + "Team meeting. Appointment.",
  );
  const result = categorize(input);
  expect(result.classification.alternatives).toEqual([
    "club_organization",
    "meeting",
    "appointment",
  ]);
  expect(
    result.evidence.filter(
      (e) => e.code === "category_keyword_club_organization",
    ),
  ).toHaveLength(2);
});
