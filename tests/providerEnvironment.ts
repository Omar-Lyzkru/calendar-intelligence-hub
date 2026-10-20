// Test process only: prevent Prisma's automatic .env loading from supplying live credentials.
export function isolateProviderEnvironment() {
  for (const name of [
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_TENANT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "MICROSOFT_REDIRECT_URI",
    "DISCORD_BOT_TOKEN",
    "DISCORD_GUILD_ID",
    "DISCORD_CHANNEL_IDS",
  ])
    process.env[name] = "";
  process.env.GOOGLE_CLIENT_ID = "synthetic";
  process.env.GOOGLE_CLIENT_SECRET = "synthetic";
  process.env.TOKEN_ENCRYPTION_KEY = "1".repeat(64);
  process.env.AUTOMATION_LIVE_WRITES_ENABLED = "false";
}
