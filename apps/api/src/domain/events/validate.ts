import {
  validateReadyEvent,
  type EventDraft,
  type ValidationResult,
} from "@hub/contracts";
export function validateEvent(draft: EventDraft): ValidationResult {
  const result = validateReadyEvent(draft);
  return result.ok
    ? result
    : { ok: false, issues: result.issues.map((i) => i.message) };
}
