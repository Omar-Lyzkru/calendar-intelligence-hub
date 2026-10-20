import type { DiscordConfig } from "./config.js";
import type { DiscordEvent } from "./runtime.js";
export function projectDispatch(
  event: { t: string; d: unknown },
  config: DiscordConfig,
  botId?: string,
): DiscordEvent[] {
  if (!event.d || typeof event.d !== "object") return [];
  const d = event.d as Record<string, any>;
  if (event.t === "GUILD_DELETE")
    return d.id === config.guildId
      ? [{ kind: "failure", reason: "discord_unavailable" }]
      : [];
  if (
    [
      "GUILD_ROLE_UPDATE",
      "GUILD_ROLE_DELETE",
      "CHANNEL_UPDATE",
      "CHANNEL_DELETE",
    ].includes(event.t)
  )
    return d.guild_id === config.guildId ? [{ kind: "permissions" }] : [];
  if (event.t === "GUILD_MEMBER_UPDATE")
    return botId && d.guild_id === config.guildId && d.user?.id === botId
      ? [{ kind: "permissions" }]
      : [];
  if (
    d.guild_id !== config.guildId ||
    typeof d.channel_id !== "string" ||
    !config.channelIds.includes(d.channel_id)
  )
    return [];
  const base = { id: d.id, guild_id: d.guild_id, channel_id: d.channel_id };
  if (event.t === "MESSAGE_DELETE") return [{ kind: "delete", payload: base }];
  if (event.t === "MESSAGE_DELETE_BULK" && Array.isArray(d.ids))
    return d.ids
      .slice(0, 100)
      .map((id) => ({ kind: "delete", payload: { ...base, id } }));
  if (event.t === "MESSAGE_UPDATE") return [{ kind: "update", payload: base }];
  if (event.t !== "MESSAGE_CREATE") return [];
  const reference = d.message_reference;
  const payload = {
    ...base,
    type: d.type,
    flags: d.flags,
    webhook_id: d.webhook_id,
    message_reference:
      reference && typeof reference === "object"
        ? {
            guild_id: reference.guild_id,
            channel_id: reference.channel_id,
            message_id: reference.message_id,
          }
        : undefined,
    timestamp: d.timestamp,
    edited_timestamp: d.edited_timestamp,
    content: d.content,
    embeds: Array.isArray(d.embeds)
      ? d.embeds.slice(0, 10).map((e) => ({
          title: e?.title,
          description: e?.description,
          fields: Array.isArray(e?.fields)
            ? e.fields.slice(0, 25).map((f: Record<string, unknown>) => ({
                name: f?.name,
                value: f?.value,
              }))
            : e?.fields,
        }))
      : d.embeds,
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > 1048576)
    return [{ kind: "failure", reason: "discord_invalid_payload" }];
  return [{ kind: "create", payload }];
}
