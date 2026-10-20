import {
  EventCategorySchema,
  type EventCategory,
  type Classification,
  type Evidence,
  type NormalizedMessage,
} from "@hub/contracts";
type SpecificCategory = Exclude<EventCategory, "other">;
const rules: Record<SpecificCategory, RegExp> = {
  academic_deadline:
    /\b(?:assignments?|homework|projects?|papers?)\s+(?:submissions?\s+)?(?:(?:is|are|will\s+be)\s+)?(?:due|deadlines?)\b|\b(?:deadlines?\s+for\s+)(?:assignments?|homework|projects?|papers?)\b/gi,
  exam_quiz: /\b(?:exams?|quizzes|quiz|midterms?)\b/gi,
  class_academic:
    /\b(?:lectures?|seminars?|class\s+sessions?|academic\s+events?)\b/gi,
  career:
    /\b(?:career\s+(?:fairs?|events?)|job\s+interviews?|recruitment\s+events?|networking\s+events?)\b/gi,
  club_organization: /\b(?:club|organization)\s+(?:meetings?|events?)\b/gi,
  social: /\b(?:parties|party|mixers?|social\s+(?:gatherings?|events?))\b/gi,
  meeting: /\bmeetings?\b/gi,
  appointment: /\bappointments?\b/gi,
  registration_deadline:
    /\b(?:registration|enrollment|sign[ -]?up)\s+(?:(?:(?:is|are|will\s+be)\s+)?(?:deadlines?|due|closes|ends)|will\s+(?:close|end))\b|\bdeadline\s+for\s+(?:registration|enrollment|sign[ -]?up)\b/gi,
  hackathon_workshop: /\b(?:hackathons?|workshops?)\b/gi,
};
export function categorize(message: NormalizedMessage): {
  classification: Classification;
  evidence: Evidence[];
} {
  const categories = EventCategorySchema.options.filter(
    (c): c is SpecificCategory => c !== "other",
  );
  const found = new Set<SpecificCategory>();
  const evidence: Evidence[] = [];
  for (const { origin, text } of [
    { origin: "subject" as const, text: message.subject || "" },
    { origin: "content" as const, text: message.content },
  ]) {
    // Only contained generic tokens are suppressed. Independent evidence survives.
    const compounds = [...text.matchAll(rules.club_organization)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
    }));
    const thirdParties = [
      ...text.matchAll(/\bthird[\s-]+part(?:y|ies)\b/gi),
    ].map((m) => ({ start: m.index, end: m.index + m[0].length }));
    for (const category of categories) {
      const excluded =
        category === "meeting"
          ? compounds
          : category === "social"
            ? thirdParties
            : [];
      let excludedIndex = 0;
      let retained = 0;
      for (const match of text.matchAll(rules[category])) {
        const start = match.index,
          end = start + match[0].length;
        // Both match streams are ordered: advance once, never rescan prior spans.
        while (
          excludedIndex < excluded.length &&
          excluded[excludedIndex].end <= start
        )
          excludedIndex++;
        const span = excluded[excludedIndex];
        if (span && start >= span.start && end <= span.end) continue;
        found.add(category);
        evidence.push({
          code: "category_keyword_" + category,
          origin,
          text: match[0],
          start,
          end,
        });
        if (++retained === 2) break;
      }
    }
  }
  const matched = categories.filter((c) => found.has(c));
  const classification: Classification =
    matched.length === 1
      ? {
          version: 1,
          status: "classified",
          category: matched[0],
          alternatives: [],
        }
      : {
          version: 1,
          status: matched.length > 1 ? "ambiguous" : "other",
          category: "other",
          alternatives: matched,
        };
  return { classification, evidence };
}
