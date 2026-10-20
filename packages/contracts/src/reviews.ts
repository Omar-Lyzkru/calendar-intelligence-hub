import type { ReviewState } from "./readiness.js";
import type { ProcessingFailure } from "./processing.js";
import type { EventDraft, EventCandidate, ReadyEvent } from "./events.js";
export interface CalendarReceipt {
  providerEventId: string;
  calendarId: string;
  htmlLink: string;
  payloadHash: string;
}
export type WriteStatus = "writing" | "added" | "failed" | "unknown";
export interface CalendarWriteOutcome {
  status: WriteStatus;
  receipt?: CalendarReceipt;
  reason?: string;
}
export interface ReviewDetail {
  id: string;
  messageId: string;
  revision: number;
  status: "needs_review" | "approved" | "writing" | "added" | "ignored";
  draft: EventDraft;
  originalText: string | null;
  subject: string | null;
  candidate: EventCandidate;
  approvedSnapshot: ReadyEvent | null;
  write: CalendarWriteOutcome | null;
  source?: {
    provider: "gmail" | "outlook" | "discord" | "unknown";
    notice?: {
      kind: "changed" | "deleted";
      revision: number;
      requiresConfirmation: boolean;
    };
    receivedAt: string;
    contentStatus: "available" | "expired_or_deleted";
  };
  checksUnavailable: true;
  state?: ReviewState;
}
export interface ImportOutcome {
  externalId: string;
  status: "review" | "no_event" | "failed";
  reviewId?: string;
  reason?: string;
  state?: ReviewState;
  processingFailure?: ProcessingFailure;
}
export interface ImportBatchResult {
  items: ImportOutcome[];
}
