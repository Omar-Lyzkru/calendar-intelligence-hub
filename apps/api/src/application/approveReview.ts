import { assertActionLock } from "./automation/actionLock.js";
import { payloadHash } from "../infrastructure/google/calendar.js";
import { Prisma } from "@prisma/client";
import { assertFreshDiscordSource } from "./discordIngestion.js";
import {
  AppError,
  EditableEventDraftSchema,
  evaluateDraft,
  hasReviewIntegrity,
  type CalendarWriteOutcome,
  type Actor,
  type EventDraft,
  type ReviewDetail,
} from "@hub/contracts";
import { db, json } from "../infrastructure/persistence/db.js";
import {
  getReview,
  assertReviewSourceOwnership,
} from "../infrastructure/persistence/reviews.js";

async function change(
  actor: Actor,
  id: string,
  expectedRevision: number,
  action: "edit" | "approve" | "ignore",
  draft?: EventDraft,
  automation?: { decisionId: string; policyRevision: number },
  transaction?: Prisma.TransactionClient,
): Promise<ReviewDetail> {
  const mutate = async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "ReviewItem" WHERE id=${id}::uuid AND "userId"=${actor.userId}::uuid FOR UPDATE`,
    );
    const r = await tx.reviewItem.findFirst({
      where: { id, userId: actor.userId },
      include: {
        detectedEvent: {
          include: {
            message: {
              select: {
                id: true,
                userId: true,
                connection: { select: { userId: true } },
              },
            },
          },
        },
        write: true,
      },
    });
    if (!r) throw new AppError("not_found", 404);
    if (r.revision !== expectedRevision || r.status !== "needs_review")
      throw new AppError("stale_review", 409);
    assertReviewSourceOwnership(r.userId, r.detectedEvent.message);
    if (
      !hasReviewIntegrity(
        r.status as ReviewDetail["status"],
        !!r.approvedSnapshot,
        r.write
          ? { status: r.write.state as CalendarWriteOutcome["status"] }
          : null,
      )
    )
      throw new AppError("record_integrity_error", 409);
    if (action === "approve")
      await assertFreshDiscordSource(tx, r.detectedEvent.message.id);
    const validatedDraft = EditableEventDraftSchema.parse(draft || r.draft);
    const validation =
      action === "approve" ? evaluateDraft(validatedDraft) : null;
    if (validation && validation.status === "blocked")
      throw new AppError("incomplete_event", 422, {
        blockers: validation.blockers,
        missingFields: validation.missingFields,
      });
    let approvalActor: "user" | "automation" = "user";
    if (automation) {
      const policy = await tx.automationPolicy.findUnique({
        where: { userId: actor.userId },
      });
      const decision = await tx.automationDecision.findFirst({
        where: {
          id: automation.decisionId,
          userId: actor.userId,
          reviewId: id,
          reviewRevision: expectedRevision,
          policyRevision: automation.policyRevision,
          decision: "auto_handle",
          reason: { in: ["eligible", "user_authorized"] },
        },
      });
      const proof = decision?.evidence as
        { readyHash?: string; checkedAt?: string } | undefined;
      const source = await tx.normalizedMessage.findUnique({
        where: { id: r.detectedEvent.message.id },
        include: { connection: true, observation: true },
      });
      const checkAge = proof?.checkedAt
        ? Date.now() - Date.parse(proof.checkedAt)
        : NaN;
      if (
        !policy?.enabled ||
        policy.revision !== automation.policyRevision ||
        !decision ||
        !validation?.event ||
        proof?.readyHash !== payloadHash(validation.event) ||
        !Number.isFinite(checkAge) ||
        checkAge < 0 ||
        checkAge > 15000 ||
        source?.connection.status !== "connected" ||
        (source.observation?.sourceRevision || 1) !== decision.sourceRevision
      )
        throw new AppError("stale_review", 409);
      const sourceAvailable =
        source.content !== null && source.expiresAt > new Date();
      const factsConfirmed =
        decision.confirmedRevision === expectedRevision &&
        decision.confirmedFields.includes("title") &&
        decision.confirmedFields.includes("temporal");
      if (!sourceAvailable && !factsConfirmed)
        throw new AppError("stale_review", 409);
      if (decision.reason === "user_authorized") {
        const consent = await tx.automationQuestion.findFirst({
          where: {
            decisionId: decision.id,
            userId: actor.userId,
            status: "answered",
            reviewRevision: expectedRevision,
            policyRevision: automation.policyRevision,
            sourceRevision: decision.sourceRevision,
            kind: { in: ["facts", "duplicate", "conflict"] },
          },
        });
        if (
          !consent ||
          decision.confirmedRevision !== expectedRevision ||
          !decision.confirmedFields.includes("permission")
        )
          throw new AppError("stale_review", 409);
        approvalActor = "user";
      } else approvalActor = "automation";
      await tx.automationDecision.update({
        where: { id: decision.id },
        data: {
          reviewRevision: expectedRevision + 1,
          ...(decision.confirmedRevision === expectedRevision
            ? { confirmedRevision: expectedRevision + 1 }
            : {}),
          evidence: json({ ...proof, autoApproved: true }),
        },
      });
    }
    const update = await tx.reviewItem.updateMany({
      where: {
        id,
        userId: actor.userId,
        revision: expectedRevision,
        status: "needs_review",
      },
      data: {
        revision: { increment: 1 },
        ...(action === "edit" ? { draft: json(validatedDraft) } : {}),
        ...(action === "approve" && validation?.event
          ? {
              status: "approved",
              approvedSnapshot: json(validation.event!),
              approvedAt: new Date(),
            }
          : {}),
        ...(action === "ignore" ? { status: "ignored" } : {}),
      },
    });
    if (update.count !== 1) throw new AppError("stale_review", 409);
    await tx.historyEntry.create({
      data: {
        userId: actor.userId,
        reviewId: id,
        action:
          action === "edit"
            ? "review_edited"
            : action === "approve"
              ? "review_approved"
              : "review_ignored",
        actor: approvalActor,
      },
    });
    // Return this mutation's exact revision while its row lock is held.
    return getReview(actor, id, new Date(), tx);
  };
  return transaction ? mutate(transaction) : db.$transaction(mutate);
}
export function saveReview(
  actor: Actor,
  id: string,
  expectedRevision: number,
  draft: EventDraft,
  transaction?: Prisma.TransactionClient,
): Promise<ReviewDetail> {
  return change(
    actor,
    id,
    expectedRevision,
    "edit",
    draft,
    undefined,
    transaction,
  );
}
export function approveReview(
  actor: Actor,
  id: string,
  expectedRevision: number,
): Promise<ReviewDetail> {
  return change(actor, id, expectedRevision, "approve");
}
export function ignoreReview(
  actor: Actor,
  id: string,
  expectedRevision: number,
  transaction?: Prisma.TransactionClient,
): Promise<ReviewDetail> {
  return change(
    actor,
    id,
    expectedRevision,
    "ignore",
    undefined,
    undefined,
    transaction,
  );
}

export async function approveAutomatically(
  actor: Actor,
  id: string,
  expectedRevision: number,
  authorization: { decisionId: string; policyRevision: number },
) {
  await assertActionLock(actor);
  return change(
    actor,
    id,
    expectedRevision,
    "approve",
    undefined,
    authorization,
  );
}
