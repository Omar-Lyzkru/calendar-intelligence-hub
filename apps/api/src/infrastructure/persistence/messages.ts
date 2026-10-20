import { Prisma } from "@prisma/client";
import {
  AppError,
  type Actor,
  type NormalizedMessage,
  type ProcessingResult,
  type ImportOutcome,
} from "@hub/contracts";
import { getReview } from "./reviews.js";
import { db, json } from "./db.js";
export async function saveProcessedMessage(
  actor: Actor,
  message: NormalizedMessage,
  result: ProcessingResult,
  transaction?: Prisma.TransactionClient,
): Promise<ImportOutcome> {
  if (actor.userId !== message.userId) throw new AppError("not_found", 404);
  const client = transaction || db;
  const connection = await client.sourceConnection.findFirst({
    where: { id: message.sourceConnectionId, userId: actor.userId },
  });
  if (!connection) throw new AppError("not_found", 404);
  const existing = async () => {
    const m = await client.normalizedMessage.findUnique({
      where: {
        sourceConnectionId_externalId: {
          sourceConnectionId: connection.id,
          externalId: message.externalId,
        },
      },
      include: { detected: { include: { review: true } } },
    });
    return m
      ? {
          externalId: m.externalId,
          status: m.detected ? ("review" as const) : ("no_event" as const),
          reviewId: m.detected?.review?.id,
          state: m.detected?.review
            ? (await getReview(actor, m.detected.review.id, new Date(), client))
                .state
            : undefined,
        }
      : null;
  };
  const prior = await existing();
  if (prior) return prior;
  const persist = async (tx: Prisma.TransactionClient) => {
    const m = await tx.normalizedMessage.create({
      data: {
        id: message.id,
        userId: actor.userId,
        sourceConnectionId: connection.id,
        externalId: message.externalId,
        source: message.source,
        sender: message.sender,
        subject: message.subject,
        content: message.content,
        receivedAt: new Date(message.receivedAt),
        ingestedAt: new Date(message.ingestedAt),
        expiresAt: new Date(
          new Date(message.ingestedAt).valueOf() + 30 * 86400000,
        ),
        sourceUrl: message.sourceUrl,
        metadata: json(message.metadata || {}),
        normalizationVersion: message.normalizationVersion,
        status: result.kind,
      },
    });
    let reviewId: string | undefined;
    if (result.kind === "review") {
      const candidate = await tx.detectedEvent.create({
        data: { messageId: m.id, candidate: json(result.candidate) },
      });
      const review = await tx.reviewItem.create({
        data: {
          userId: actor.userId,
          detectedEventId: candidate.id,
          draft: json(result.candidate.draft),
        },
      });
      reviewId = review.id;
    }
    await tx.processingAttempt.create({
      data: {
        sourceConnectionId: connection.id,
        externalId: message.externalId,
        messageId: m.id,
        stage: "process",
        outcome: result.kind,
      },
    });
    await tx.historyEntry.create({
      data: {
        userId: actor.userId,
        messageId: m.id,
        reviewId,
        action: "message_processed",
        reason: result.kind,
      },
    });
    return { externalId: message.externalId, status: result.kind, reviewId };
  };
  // An outer transaction owns retry/locking; never catch a constraint error inside an aborted PostgreSQL transaction.
  if (transaction) return persist(transaction);
  try {
    return await db.$transaction(persist);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const found = await existing();
      if (found) return found;
    }
    throw error;
  }
}
