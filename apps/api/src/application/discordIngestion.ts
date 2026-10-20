import { purgeExpiredContent } from "../infrastructure/persistence/retention.js";
import { randomUUID } from "node:crypto";
import { Prisma, type DiscordObservation } from "@prisma/client";
import { AppError, type Actor, type ImportOutcome } from "@hub/contracts";
import { db } from "../infrastructure/persistence/db.js";
import { saveProcessedMessage } from "../infrastructure/persistence/messages.js";
import { getReview } from "../infrastructure/persistence/reviews.js";
import { activeRelay } from "../infrastructure/discord/connections.js";
import {
  isSnowflake,
  type DiscordConfig,
} from "../infrastructure/discord/config.js";
import {
  isFollowRelay,
  normalizeDiscord,
} from "../infrastructure/discord/normalize.js";
import { processMessage } from "./processMessage.js";
type Change = { kind: "update" | "delete"; payload: unknown };
function scoped(
  payload: unknown,
  config: DiscordConfig,
): payload is Record<string, unknown> & { id: string; channel_id: string } {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    isSnowflake(p.id) &&
    p.guild_id === config.guildId &&
    typeof p.channel_id === "string" &&
    config.channelIds.includes(p.channel_id)
  );
}
function edited(payload: Record<string, unknown>) {
  const value = payload.edited_timestamp;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value))
    return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date : null;
}
async function sourceChange(
  tx: Prisma.TransactionClient,
  actor: Actor,
  observation: DiscordObservation,
  change: Change,
  config: DiscordConfig,
) {
  const p = change.payload as Record<string, unknown>;
  const time = edited(p);
  if (
    observation.sourceState === "deleted" ||
    (change.kind === "update" &&
      (!time ||
        (observation.observedEditedAt && time <= observation.observedEditedAt)))
  )
    return;
  const message = observation.messageId
    ? await tx.normalizedMessage.findUnique({
        where: { id: observation.messageId },
        include: { detected: { include: { review: true } } },
      })
    : null;
  const reviewId = message?.detected?.review?.id;
  // All decision paths lock ReviewItem before checking or changing source state.
  if (reviewId)
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "ReviewItem" WHERE id=${reviewId}::uuid FOR UPDATE`,
    );
  let meaningful = true;
  if (
    change.kind === "update" &&
    observation.sourceState === "current" &&
    message?.content &&
    message.expiresAt > new Date()
  ) {
    try {
      const normalized = normalizeDiscord(
        p,
        {
          id: message.id,
          userId: actor.userId,
          sourceConnectionId: observation.sourceConnectionId,
          ingestedAt: new Date().toISOString(),
        },
        config,
      );
      meaningful = normalized.content !== message.content;
    } catch {
      /* Unreadable edited text is an unknown change, never absence of an event. */
    }
  }
  await tx.discordObservation.update({
    where: { id: observation.id },
    data: {
      observedEditedAt: time || observation.observedEditedAt,
      ...(meaningful
        ? {
            sourceState: change.kind === "delete" ? "deleted" : "changed",
            sourceRevision: { increment: 1 },
          }
        : {}),
    },
  });
  if (!meaningful) return;
  if (reviewId)
    await tx.reviewItem.update({
      where: { id: reviewId },
      data: { revision: { increment: 1 } },
    });
  await tx.historyEntry.create({
    data: {
      userId: actor.userId,
      messageId: message?.id,
      reviewId,
      action:
        change.kind === "delete"
          ? "discord_source_deleted"
          : "discord_source_changed",
    },
  });
}
export async function ingestDiscord(
  config: DiscordConfig,
  payload: unknown,
  generation: number,
): Promise<ImportOutcome | { status: "ignored" }> {
  if (!isFollowRelay(payload, config) || !scoped(payload, config))
    return { status: "ignored" };
  // Reuse mailbox retention cleanup before acquiring relay/review locks.
  await purgeExpiredContent(new Date());
  return db.$transaction(
    async (tx) => {
      const binding = await activeRelay(config, generation, tx);
      if (!binding) return { status: "ignored" as const };
      const { source, actor, relay } = binding;
      const key = {
        sourceConnectionId_externalId: {
          sourceConnectionId: source.id,
          externalId: payload.id,
        },
      };
      let receipt = await tx.discordObservation.findUnique({ where: key });
      if (receipt) {
        const retryTime = edited(payload);
        const canRecover =
          !receipt.messageId &&
          receipt.sourceState !== "deleted" &&
          !((Number(payload.flags) || 0) & 8) &&
          !!retryTime &&
          (!receipt.observedEditedAt || retryTime > receipt.observedEditedAt);
        if ((Number(payload.flags) || 0) & 8)
          await sourceChange(
            tx,
            actor,
            receipt,
            { kind: "delete", payload },
            config,
          );
        else if (receipt.messageId && edited(payload))
          await sourceChange(
            tx,
            actor,
            receipt,
            { kind: "update", payload },
            config,
          );
        if (receipt.messageId) {
          const m = await tx.normalizedMessage.findUniqueOrThrow({
            where: { id: receipt.messageId },
            include: { detected: { include: { review: true } } },
          });
          const reviewId = m.detected?.review?.id;
          return {
            externalId: payload.id,
            status: m.detected ? ("review" as const) : ("no_event" as const),
            reviewId,
            ...(reviewId
              ? {
                  state: (await getReview(actor, reviewId, new Date(), tx))
                    .state,
                }
              : {}),
          };
        }
        if (!canRecover)
          return {
            externalId: payload.id,
            status: "failed" as const,
            reason: receipt.errorCode || "discord_unsupported_content",
          };
        receipt = await tx.discordObservation.update({
          where: { id: receipt.id },
          data: { observedEditedAt: retryTime, status: "received" },
        });
      } else
        receipt = await tx.discordObservation.create({
          data: {
            sourceConnectionId: source.id,
            externalId: payload.id,
            channelId: payload.channel_id,
            status: "received",
            observedEditedAt: edited(payload),
          },
        });
      let message;
      try {
        if ((Number(payload.flags) || 0) & 8)
          throw new AppError("discord_source_deleted", 422);
        message = normalizeDiscord(
          payload,
          {
            id: randomUUID(),
            userId: actor.userId,
            sourceConnectionId: source.id,
            ingestedAt: new Date().toISOString(),
          },
          config,
        );
      } catch (error) {
        const allowed = [
          "discord_invalid_source",
          "discord_invalid_payload",
          "invalid_received_date",
          "message_too_large",
          "discord_unsupported_content",
          "discord_source_deleted",
        ];
        const code =
          error instanceof AppError && allowed.includes(error.code)
            ? error.code
            : "discord_invalid_payload";
        await tx.discordObservation.update({
          where: { id: receipt.id },
          data: {
            status: "failed",
            errorCode: code,
            ...(code === "discord_source_deleted"
              ? { sourceState: "deleted" }
              : {}),
          },
        });
        await tx.processingAttempt.create({
          data: {
            sourceConnectionId: source.id,
            externalId: payload.id,
            stage: "normalize",
            outcome: "failed",
            errorCode: code,
          },
        });
        await tx.historyEntry.create({
          data: {
            userId: actor.userId,
            action: "discord_message_unsupported",
            reason: code,
          },
        });
        return {
          externalId: payload.id,
          status: "failed" as const,
          reason: code,
        };
      }
      const result = processMessage(message, relay.user.timezone);
      const outcome = await saveProcessedMessage(actor, message, result, tx);
      await tx.discordObservation.update({
        where: { id: receipt.id },
        data: { status: "processed", messageId: message.id, errorCode: null },
      });
      return outcome;
    },
    { timeout: 10000 },
  );
}
export async function recordDiscordChange(
  config: DiscordConfig,
  event: Change,
  generation: number,
) {
  if (!scoped(event.payload, config)) return;
  const payload = event.payload;
  await db.$transaction(async (tx) => {
    const binding = await activeRelay(config, generation, tx);
    if (!binding) return;
    const observation = await tx.discordObservation.findUnique({
      where: {
        sourceConnectionId_externalId: {
          sourceConnectionId: binding.source.id,
          externalId: payload.id,
        },
      },
    });
    if (!observation || observation.channelId !== payload.channel_id) return;
    await sourceChange(tx, binding.actor, observation, event, config);
  });
}
// Called only after the decision path's ReviewItem lock is held.
export async function assertFreshDiscordSource(
  tx: Prisma.TransactionClient,
  messageId: string,
) {
  const observation = await tx.discordObservation.findUnique({
    where: { messageId },
  });
  if (
    observation &&
    observation.sourceRevision > observation.acknowledgedRevision
  )
    throw new AppError("source_confirmation_required", 409);
}
export async function confirmDiscordSource(
  actor: Actor,
  id: string,
  expectedRevision: number,
  sourceRevision: number,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "ReviewItem" WHERE id=${id}::uuid AND "userId"=${actor.userId}::uuid FOR UPDATE`,
    );
    const r = await tx.reviewItem.findFirst({
      where: { id, userId: actor.userId },
      include: {
        detectedEvent: {
          include: {
            message: { include: { observation: true, connection: true } },
          },
        },
      },
    });
    if (!r) throw new AppError("not_found", 404);
    const m = r.detectedEvent.message,
      o = m.observation;
    if (m.userId !== actor.userId || m.connection.userId !== actor.userId)
      throw new AppError("record_integrity_error", 409);
    if (
      !o ||
      r.revision !== expectedRevision ||
      o.sourceRevision !== sourceRevision ||
      o.acknowledgedRevision === sourceRevision
    )
      throw new AppError("stale_review", 409);
    await tx.discordObservation.update({
      where: { id: o.id },
      data: { acknowledgedRevision: sourceRevision },
    });
    await tx.reviewItem.update({
      where: { id },
      data: { revision: { increment: 1 } },
    });
    await tx.historyEntry.create({
      data: {
        userId: actor.userId,
        reviewId: id,
        action: "discord_source_confirmed",
        actor: "user",
      },
    });
    return getReview(actor, id, new Date(), tx);
  });
}
