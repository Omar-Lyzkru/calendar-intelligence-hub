import type { Prisma } from "@prisma/client";
import {
  AppError,
  CandidateSchema,
  EditableEventDraftSchema,
  evaluateDraft,
  deriveReviewState,
  hasReviewIntegrity,
  ReadyEventSchema,
  type Actor,
  type ReviewDetail,
  type EventCandidate,
  type CalendarWriteOutcome,
} from "@hub/contracts";
import { db } from "./db.js";
export function redactCandidate(candidate: EventCandidate): EventCandidate {
  return {
    ...candidate,
    evidence: candidate.evidence.map((e) => ({ code: e.code })),
    draft: {
      ...candidate.draft,
      temporal:
        candidate.draft.temporal.kind === "unresolved"
          ? { ...candidate.draft.temporal, text: "" }
          : candidate.draft.temporal,
    },
  };
}
export function assertReviewSourceOwnership(
  userId: string,
  message: { userId: string; connection: { userId: string } },
): void {
  if (message.userId !== userId || message.connection.userId !== userId)
    throw new AppError("record_integrity_error", 409);
}
export async function getReview(
  actor: Actor,
  id: string,
  now = new Date(),
  client: Pick<Prisma.TransactionClient, "reviewItem"> = db,
): Promise<ReviewDetail> {
  const r = await client.reviewItem.findFirst({
    where: { id, userId: actor.userId },
    include: {
      detectedEvent: {
        include: {
          message: {
            include: {
              observation: true,
              connection: { select: { userId: true } },
            },
          },
        },
      },
      write: true,
    },
  });
  if (!r) throw new AppError("not_found", 404);
  const m = r.detectedEvent.message;
  assertReviewSourceOwnership(r.userId, m);
  const expired = !m.content || m.expiresAt <= now;
  const candidate = CandidateSchema.parse(r.detectedEvent.candidate);
  let draft = EditableEventDraftSchema.parse(r.draft);
  if (expired && draft.temporal.kind === "unresolved")
    draft = { ...draft, temporal: { ...draft.temporal, text: "" } };
  const receipt = r.write
    ?.receipt as unknown as CalendarWriteOutcome["receipt"];
  const write: CalendarWriteOutcome | null = r.write
    ? {
        status: r.write.state as CalendarWriteOutcome["status"],
        receipt: receipt || undefined,
        reason: r.write.errorCode || undefined,
      }
    : null;
  const snapshot = r.approvedSnapshot
    ? ReadyEventSchema.parse(r.approvedSnapshot)
    : null;
  const integrityValid =
    m.userId === r.userId &&
    hasReviewIntegrity(r.status as ReviewDetail["status"], !!snapshot, write);
  const notice =
    m.observation && m.observation.sourceState !== "current"
      ? {
          kind:
            m.observation.sourceState === "deleted"
              ? ("deleted" as const)
              : ("changed" as const),
          revision: m.observation.sourceRevision,
          requiresConfirmation:
            m.observation.sourceRevision > m.observation.acknowledgedRevision,
        }
      : undefined;
  const state = deriveReviewState(
    r.status as ReviewDetail["status"],
    evaluateDraft(snapshot || draft, { legacyTitle: !!snapshot }),
    write,
    { leaseActive: !!r.write && r.write.leaseUntil > now, integrityValid },
  );
  if (notice?.requiresConfirmation && r.status !== "added") {
    state.readiness.status = "blocked";
    state.readiness.blockers.push({
      field: "source",
      code: "source_confirmation_required",
      kind: "confirmation_required",
      message:
        "Check the latest Discord announcement and confirm it before proceeding.",
    });
    state.actions.approve = false;
    state.actions.write = false;
    state.recovery = {
      action: "resolve_issue",
      canRetryNow: false,
      message:
        "The Discord source changed or was deleted. Check it and confirm your decision.",
    };
  }
  return {
    id: r.id,
    messageId: m.id,
    revision: r.revision,
    status: r.status as ReviewDetail["status"],
    draft,
    subject: m.subject,
    originalText: expired ? null : m.content,
    candidate: expired ? redactCandidate(candidate) : candidate,
    approvedSnapshot: snapshot,
    write,
    state,
    source: {
      notice,
      provider:
        m.source === "gmail" || m.source === "outlook" || m.source === "discord"
          ? m.source
          : "unknown",
      receivedAt: m.receivedAt.toISOString(),
      contentStatus: expired ? "expired_or_deleted" : "available",
    },
    checksUnavailable: true,
  };
}
