import { assertFreshDiscordSource } from "../../application/discordIngestion.js";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  AppError,
  validateReadyEvent,
  hasReviewIntegrity,
  type ReviewDetail,
  type Actor,
  type CalendarWriteOutcome,
} from "@hub/contracts";
import { db, json } from "./db.js";
import { assertReviewSourceOwnership } from "./reviews.js";
import { payloadHash } from "../google/calendar.js";
export async function claimWrite(actor: Actor, reviewId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "ReviewItem" WHERE id=${reviewId}::uuid AND "userId"=${actor.userId}::uuid FOR UPDATE`,
    );
    const r = await tx.reviewItem.findFirst({
      where: { id: reviewId, userId: actor.userId },
      include: {
        write: true,
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
      },
    });
    if (!r) throw new AppError("not_found", 404);
    assertReviewSourceOwnership(r.userId, r.detectedEvent.message);
    if (
      !r.approvedSnapshot ||
      !["approved", "writing", "added"].includes(r.status)
    )
      throw new AppError("approval_required", 409);
    if (
      !hasReviewIntegrity(
        r.status as ReviewDetail["status"],
        !!r.approvedSnapshot,
        r.write
          ? {
              status: r.write.state as CalendarWriteOutcome["status"],
              receipt: r.write
                .receipt as unknown as CalendarWriteOutcome["receipt"],
            }
          : null,
      )
    )
      throw new AppError("record_integrity_error", 409);
    if (r.write?.state === "added")
      return {
        kind: "existing" as const,
        outcome: {
          status: "added",
          receipt: r.write.receipt,
        } as unknown as CalendarWriteOutcome,
      };
    if (r.write?.state === "writing" && r.write.leaseUntil > new Date())
      return {
        kind: "existing" as const,
        outcome: { status: "writing" } as CalendarWriteOutcome,
      };
    await assertFreshDiscordSource(tx, r.detectedEvent.message.id);
    const validated = validateReadyEvent(r.approvedSnapshot);
    if (!validated.ok) throw new AppError("invalid_approved_event", 422);
    const event = validated.event;
    const token = randomUUID();
    const data = {
      state: "writing",
      claimToken: token,
      leaseUntil: new Date(Date.now() + 60000),
      errorCode: null,
    };
    const intent = r.write
      ? await tx.calendarEvent.update({ where: { id: r.write.id }, data })
      : await tx.calendarEvent.create({
          data: {
            ...data,
            reviewItemId: reviewId,
            providerEventId: randomUUID().replaceAll("-", ""),
            payload: json(event),
            payloadHash: payloadHash(event),
          },
        });
    await tx.reviewItem.update({
      where: { id: reviewId },
      data: { status: "writing" },
    });
    await tx.historyEntry.create({
      data: {
        userId: actor.userId,
        reviewId,
        action: "calendar_write_started",
      },
    });
    return { kind: "claimed" as const, intent, event };
  });
}
export async function finishWrite(
  actor: Actor,
  reviewId: string,
  intentId: string,
  claimToken: string,
  outcome: CalendarWriteOutcome,
) {
  await db.$transaction(async (tx) => {
    const update = await tx.calendarEvent.updateMany({
      where: { id: intentId, claimToken },
      data: {
        state: outcome.status,
        errorCode: outcome.reason || null,
        leaseUntil: new Date(0),
        ...(outcome.receipt ? { receipt: json(outcome.receipt) } : {}),
      },
    });
    if (!update.count) return;
    await tx.reviewItem.updateMany({
      where: { id: reviewId, userId: actor.userId },
      data: { status: outcome.status === "added" ? "added" : "approved" },
    });
    await tx.historyEntry.create({
      data: {
        userId: actor.userId,
        reviewId,
        action: "calendar_write_" + outcome.status,
        reason: outcome.reason,
      },
    });
  });
}
