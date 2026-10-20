import { withActionLock, assertActionLock } from "./automation/actionLock.js";
import {
  AppError,
  safeErrorCode,
  type Actor,
  type CalendarWriteOutcome,
  type CalendarReceipt,
} from "@hub/contracts";
import type { CalendarGateway } from "../infrastructure/google/calendar.js";
import {
  claimWrite,
  finishWrite,
} from "../infrastructure/persistence/calendarWrites.js";
async function executeCalendarEvent(
  actor: Actor,
  reviewId: string,
  gateway: CalendarGateway,
): Promise<CalendarWriteOutcome> {
  const claim = await claimWrite(actor, reviewId);
  if (claim.kind === "existing") return claim.outcome;
  const { intent, event } = claim;
  let outcome: CalendarWriteOutcome;
  const matches = (receipt: CalendarReceipt) =>
    receipt.providerEventId === intent.providerEventId &&
    receipt.calendarId === "primary" &&
    receipt.payloadHash === intent.payloadHash;
  try {
    let receipt = await gateway.get(actor, intent.providerEventId);
    if (!receipt) {
      try {
        await assertActionLock(actor);
        receipt = await gateway.insert(
          actor,
          intent.providerEventId,
          event,
          intent.payloadHash,
        );
      } catch (error) {
        if (error instanceof AppError && error.code === "provider_collision")
          receipt = await gateway.get(actor, intent.providerEventId);
        else throw error;
      }
    }
    outcome =
      receipt && matches(receipt)
        ? { status: "added", receipt }
        : { status: "failed", reason: "event_mismatch" };
  } catch (error) {
    const reason =
      error instanceof AppError
        ? safeErrorCode(error.code, "provider_unavailable")
        : "provider_unavailable";
    outcome = {
      status:
        reason === "reauthorization_required" ||
        reason === "provider_rate_limited"
          ? "failed"
          : "unknown",
      reason,
    };
  }
  await finishWrite(actor, reviewId, intent.id, intent.claimToken, outcome);
  return outcome;
}

export async function createCalendarEvent(
  actor: Actor,
  reviewId: string,
  gateway: CalendarGateway,
): Promise<CalendarWriteOutcome> {
  return withActionLock(actor, () =>
    executeCalendarEvent(actor, reviewId, gateway),
  );
}
