import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  safeFailure,
  type ProcessingStage,
  type Actor,
  type ImportBatchResult,
  type MessageSourceAdapter,
} from "@hub/contracts";
import type { GmailGateway } from "../infrastructure/google/gmail.js";
import { db } from "../infrastructure/persistence/db.js";
import { purgeExpiredContent } from "../infrastructure/persistence/retention.js";
import { getReview } from "../infrastructure/persistence/reviews.js";
import { saveProcessedMessage } from "../infrastructure/persistence/messages.js";
import { gmailSource } from "./sourceAdapters.js";
import { processMessage } from "./processMessage.js";
export async function importMessages(
  actor: Actor,
  externalIds: string[],
  source: GmailGateway | MessageSourceAdapter,
): Promise<ImportBatchResult> {
  const adapter = "provider" in source ? source : gmailSource(source);
  const ids = z
    .array(
      z
        .string()
        .min(1)
        .max(adapter.provider === "outlook" ? 512 : 128),
    )
    .min(1)
    .max(20)
    .safeParse(externalIds);
  if (!ids.success) throw new AppError("invalid_selection", 422);
  const connection = await db.sourceConnection.findFirst({
    where: {
      userId: actor.userId,
      provider: adapter.provider,
      status: "connected",
    },
    include: { user: true },
  });
  if (!connection)
    throw new AppError(
      adapter.provider === "outlook"
        ? "microsoft_reauthorization_required"
        : "reauthorization_required",
      403,
    );
  await purgeExpiredContent(new Date());
  const items: ImportBatchResult["items"] = [];
  let throttled: AppError | undefined;
  for (const externalId of new Set(ids.data)) {
    let stage: ProcessingStage = "persist";
    try {
      const prior = await db.normalizedMessage.findUnique({
        where: {
          sourceConnectionId_externalId: {
            sourceConnectionId: connection.id,
            externalId,
          },
        },
        include: { detected: { include: { review: true } } },
      });
      if (prior) {
        items.push({
          externalId,
          status: prior.detected ? "review" : "no_event",
          reviewId: prior.detected?.review?.id,
          state: prior.detected?.review
            ? (await getReview(actor, prior.detected.review.id)).state
            : undefined,
        });
        continue;
      }
      stage = "fetch";
      // A provider's Retry-After applies to further reads in this manual batch.
      // Prior local results remain usable without another provider request.
      if (throttled) throw throttled;
      const payload = await adapter.get(actor, externalId);
      stage = "normalize";
      const message = adapter.normalize(payload, {
        id: randomUUID(),
        userId: actor.userId,
        sourceConnectionId: connection.id,
        ingestedAt: new Date().toISOString(),
      });
      if (
        message.externalId !== externalId ||
        message.source !== adapter.provider ||
        message.sourceConnectionId !== connection.id ||
        message.userId !== actor.userId
      )
        throw new AppError("provider_id_mismatch", 502);
      stage = "process";
      const processed = processMessage(message, connection.user.timezone);
      stage = "persist";
      const saved = await saveProcessedMessage(actor, message, processed);
      if (saved.reviewId)
        saved.state = (await getReview(actor, saved.reviewId)).state;
      items.push(saved);
    } catch (error) {
      if (error instanceof AppError && error.code === "microsoft_rate_limited")
        throttled = error;
      const failure = safeFailure(
        stage,
        error instanceof AppError ? error.code : undefined,
      );
      if (
        error instanceof AppError &&
        error.code === "microsoft_rate_limited" &&
        Number.isInteger(error.retryAfterSeconds) &&
        error.retryAfterSeconds! >= 1 &&
        error.retryAfterSeconds! <= 86400
      )
        failure.retryAfterSeconds = error.retryAfterSeconds;
      try {
        const attempt = await db.$transaction(async (tx) => {
          const attempt = await tx.processingAttempt.create({
            data: {
              sourceConnectionId: connection.id,
              externalId,
              stage,
              outcome: "failed",
              errorCode: failure.code,
            },
          });
          await tx.historyEntry.create({
            data: {
              userId: actor.userId,
              action: "import_" + stage + "_failed",
              reason: failure.code,
            },
          });
          return attempt;
        });
        items.push({
          externalId,
          status: "failed",
          reason: failure.code,
          processingFailure: { ...failure, attemptId: attempt.id },
        });
      } catch {
        throw new AppError("persistence_failed", 503);
      }
    }
  }
  return { items };
}
