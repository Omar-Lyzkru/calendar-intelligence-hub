import type { NormalizedMessage, ProcessingResult } from "@hub/contracts";
import { classify } from "../domain/events/classify.js";
import { extract } from "../domain/events/extract.js";
export function processMessage(
  message: NormalizedMessage,
  timezone: string,
): ProcessingResult {
  if (!classify(message).isCandidate)
    return { kind: "no_event", reasons: ["no_event_signal"] };
  return { kind: "review", candidate: extract(message, timezone) };
}
