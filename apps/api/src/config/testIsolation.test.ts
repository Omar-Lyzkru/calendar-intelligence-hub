import { it, expect } from "vitest";
it("unit runner isolates database and provider configuration before application imports", () => {
  expect(
    process.env.DATABASE_URL ===
      "postgresql://synthetic@127.0.0.1:1/calendar_unit_test",
  ).toBe(true);
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
