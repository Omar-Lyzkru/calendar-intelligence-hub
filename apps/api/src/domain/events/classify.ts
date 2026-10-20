import type { NormalizedMessage } from "@hub/contracts";
import { categorize } from "./categorize.js";
const signals =
  /\b(exam|quiz|homework|assignment|deadline|due|meeting|workshop|career fair|networking|hackathon|registration|rsvp|interview|event|appointment)\b/gi;
export function classify(message: NormalizedMessage) {
  const text = [message.subject, message.content].filter(Boolean).join("\n");
  const hits = [...text.matchAll(signals)];
  return {
    isCandidate:
      hits.length > 0 || categorize(message).classification.status !== "other",
    evidence: hits.map((m) => ({
      code: "event_keyword",
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })),
  };
}
