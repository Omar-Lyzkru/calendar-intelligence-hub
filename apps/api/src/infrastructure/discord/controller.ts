import type { Config } from "../../config/env.js";
import { db } from "../persistence/db.js";
import { readDiscordConfig } from "./config.js";
import { DiscordRest } from "./rest.js";
import { DiscordRuntime } from "./runtime.js";
import { gatewayTransport } from "./gateway.js";
import {
  ingestDiscord,
  recordDiscordChange,
} from "../../application/discordIngestion.js";
export function discordRuntime(config: Config) {
  const scoped = readDiscordConfig({
    DISCORD_BOT_TOKEN: config.DISCORD_BOT_TOKEN,
    DISCORD_GUILD_ID: config.DISCORD_GUILD_ID,
    DISCORD_CHANNEL_IDS: config.DISCORD_CHANNEL_IDS,
  });
  if (!scoped) return null;
  return new DiscordRuntime(
    scoped,
    new DiscordRest(scoped),
    gatewayTransport(scoped),
    {
      binding: async () => {
        const relay = await db.discordRelay.findUnique({
          where: { guildId: scoped.guildId },
          include: { connections: true },
        });
        if (
          !relay ||
          relay.status !== "connected" ||
          relay.channelIds.length !== scoped.channelIds.length ||
          !relay.channelIds.every((c) => scoped.channelIds.includes(c)) ||
          !relay.connections.some(
            (c) =>
              c.provider === "discord" &&
              c.userId === relay.userId &&
              c.status === "connected",
          )
        )
          return null;
        return { generation: relay.generation };
      },
      ingest: (p, g) => ingestDiscord(scoped, p, g),
      change: (e, g) => recordDiscordChange(scoped, e, g),
    },
  );
}
