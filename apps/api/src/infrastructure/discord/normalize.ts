import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import {
  AppError,
  type NormalizationContext,
  type NormalizedMessage,
} from "@hub/contracts";
import { isSnowflake, type DiscordConfig } from "./config.js";
const id = z.string().refine(isSnowflake);
const scope = z.object({
  id,
  guild_id: id,
  channel_id: id,
  type: z.literal(0),
  flags: z.number().int().nonnegative().optional(),
});
const reference = z.object({ guild_id: id, channel_id: id, message_id: id });
const visibleEmbed = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  fields: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .max(25)
    .optional(),
});
export function isFollowRelay(
  payload: unknown,
  config: DiscordConfig,
): boolean {
  const parsed = scope.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.guild_id !== config.guildId ||
    !config.channelIds.includes(parsed.data.channel_id)
  )
    return false;
  const raw = payload as Record<string, unknown>;
  return (
    !!((parsed.data.flags || 0) & 2) &&
    isSnowflake(raw.webhook_id) &&
    reference.safeParse(raw.message_reference).success
  );
}
export function normalizeDiscord(
  payload: unknown,
  context: NormalizationContext,
  config: DiscordConfig,
  mode: "follow" | "manual-smoke" = "follow",
): NormalizedMessage {
  const parsed = scope.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.guild_id !== config.guildId ||
    !config.channelIds.includes(parsed.data.channel_id) ||
    (mode === "follow" && !isFollowRelay(payload, config))
  )
    throw new AppError("discord_invalid_source", 422);
  const data = z
    .object({
      content: z.string(),
      timestamp: z.iso.datetime({ offset: true }),
      embeds: z.array(visibleEmbed).max(10),
      attachments: z.array(z.unknown()).optional(),
    })
    .safeParse(payload);
  if (!data.success) throw new AppError("discord_invalid_payload", 422);
  let receivedAt: string;
  try {
    receivedAt = Temporal.Instant.from(data.data.timestamp).toString({
      smallestUnit: "millisecond",
    });
  } catch {
    throw new AppError("invalid_received_date", 422);
  }
  const parts = [
    data.data.content,
    ...data.data.embeds.map((e) =>
      [
        e.title,
        e.description,
        ...(e.fields || []).map((f) => f.name + ": " + f.value),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].filter((p) => p.trim());
  const content = parts
    .join("\n\n")
    .replace(/<@!?\d+>/g, "@user")
    .replace(/<@&\d+>/g, "@role")
    .replace(/<#\d+>/g, "#channel");
  if (Buffer.byteLength(content, "utf8") > 262144)
    throw new AppError("message_too_large", 422);
  if (!content.trim()) throw new AppError("discord_unsupported_content", 422);
  return {
    ...context,
    externalId: parsed.data.id,
    source: "discord",
    content,
    receivedAt,
    normalizationVersion: 1,
    metadata: { channelId: parsed.data.channel_id },
  };
}
