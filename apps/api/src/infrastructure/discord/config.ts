export interface DiscordConfig {
  token: string;
  guildId: string;
  channelIds: string[];
}
export function isSnowflake(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{16,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}
export function readDiscordConfig(
  input: Record<string, string | undefined>,
): DiscordConfig | null {
  const token = input.DISCORD_BOT_TOKEN?.trim(),
    guildId = input.DISCORD_GUILD_ID?.trim();
  const channels = (input.DISCORD_CHANNEL_IDS || "")
    .split(",")
    .map((v) => v.trim());
  if (
    !token ||
    token.length < 20 ||
    token.length > 256 ||
    !isSnowflake(guildId) ||
    channels.length > 10 ||
    !channels.every(isSnowflake) ||
    new Set(channels).size !== channels.length
  )
    return null;
  return { token, guildId, channelIds: channels };
}
