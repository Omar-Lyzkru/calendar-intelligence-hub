import { Prisma } from "@prisma/client";
import { AppError, type Actor } from "@hub/contracts";
import { db } from "../persistence/db.js";
import type { DiscordConfig } from "./config.js";
export async function connectRelay(actor: Actor, config: DiscordConfig) {
  return db.$transaction(async (tx) => {
    // Serialize first ownership allocation as well as subsequent changes.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${config.guildId},0))::text`;
    const owned = await tx.discordRelay.findFirst({
      where: { OR: [{ userId: actor.userId }, { guildId: config.guildId }] },
    });
    if (
      owned &&
      (owned.userId !== actor.userId || owned.guildId !== config.guildId)
    )
      throw new AppError("discord_relay_owned", 409);
    if (owned)
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "DiscordRelay" WHERE id=${owned.id}::uuid FOR UPDATE`,
      );
    const relay = owned
      ? await tx.discordRelay.update({
          where: { id: owned.id },
          data: {
            status: "connected",
            channelIds: config.channelIds,
            generation: { increment: 1 },
          },
        })
      : await tx.discordRelay.create({
          data: {
            userId: actor.userId,
            guildId: config.guildId,
            channelIds: config.channelIds,
          },
        });
    const source = await tx.sourceConnection.upsert({
      where: { userId_provider: { userId: actor.userId, provider: "discord" } },
      create: {
        userId: actor.userId,
        provider: "discord",
        discordRelayId: relay.id,
        externalAccountId: config.guildId,
      },
      update: { status: "connected" },
    });
    await tx.historyEntry.create({
      data: {
        userId: actor.userId,
        action: "discord_connected",
        actor: "user",
      },
    });
    return { sourceConnectionId: source.id, generation: relay.generation };
  });
}
export async function disconnectRelay(actor: Actor) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "DiscordRelay" WHERE "userId"=${actor.userId}::uuid FOR UPDATE`,
    );
    const relay = await tx.discordRelay.findUnique({
      where: { userId: actor.userId },
    });
    if (!relay) return;
    await tx.discordRelay.update({
      where: { id: relay.id },
      data: { status: "disconnected", generation: { increment: 1 } },
    });
    await tx.historyEntry.create({
      data: {
        userId: actor.userId,
        action: "discord_disconnected",
        actor: "user",
      },
    });
    await tx.sourceConnection.updateMany({
      where: { userId: actor.userId, provider: "discord" },
      data: { status: "disconnected" },
    });
  });
}
export async function activeRelay(
  config: DiscordConfig,
  generation: number,
  tx: Prisma.TransactionClient,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "DiscordRelay" WHERE "guildId"=${config.guildId} FOR UPDATE`,
  );
  const relay = await tx.discordRelay.findUnique({
    where: { guildId: config.guildId },
    include: { user: true, connections: true },
  });
  const source = relay?.connections.find(
    (c) =>
      c.provider === "discord" &&
      c.userId === relay.userId &&
      c.status === "connected",
  );
  if (
    !relay ||
    !source ||
    relay.status !== "connected" ||
    relay.generation !== generation ||
    relay.channelIds.length !== config.channelIds.length ||
    !relay.channelIds.every((c) => config.channelIds.includes(c))
  )
    return null;
  return { relay, source, actor: { userId: relay.userId } };
}
export async function getRelayStatus(
  actor: Actor,
  config: DiscordConfig | null,
) {
  const relay = await db.discordRelay.findUnique({
    where: { userId: actor.userId },
  });
  return {
    configured: !!config,
    status:
      relay?.status === "connected" &&
      config &&
      relay.guildId === config.guildId &&
      relay.channelIds.length === config.channelIds.length &&
      relay.channelIds.every((c) => config.channelIds.includes(c))
        ? ("connected" as const)
        : ("disconnected" as const),
  };
}
