import { it, expect } from "vitest";
it("integration runner uses the disposable database without inherited provider credentials", () => {
  expect(process.env.DATABASE_URL === process.env.TEST_DATABASE_URL).toBe(true);
  for (const name of [
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_TENANT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "MICROSOFT_REDIRECT_URI",
    "DISCORD_BOT_TOKEN",
    "DISCORD_GUILD_ID",
    "DISCORD_CHANNEL_IDS",
  ])
    expect(process.env[name] === "").toBe(true);
  expect(process.env.GOOGLE_CLIENT_SECRET === "synthetic").toBe(true);
  expect(process.env.AUTOMATION_LIVE_WRITES_ENABLED === "false").toBe(true);
});
