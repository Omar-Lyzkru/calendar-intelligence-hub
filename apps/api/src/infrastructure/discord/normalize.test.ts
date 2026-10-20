import { it, expect } from "vitest";
import { isFollowRelay, normalizeDiscord } from "./normalize.js";
import { readDiscordConfig } from "./config.js";
import { observeMessages } from "./observe.js";
const config = {
  token: "synthetic-discord-token-only",
  guildId: "100000000000000001",
  channelIds: ["100000000000000002"],
};
const context = {
  id: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  sourceConnectionId: crypto.randomUUID(),
  ingestedAt: "2026-10-13T12:00:00Z",
};
const post = {
  id: "100000000000000003",
  guild_id: config.guildId,
  channel_id: config.channelIds[0],
  type: 0,
  flags: 2,
  webhook_id: "100000000000000004",
  message_reference: {
    guild_id: "100000000000000005",
    channel_id: "100000000000000006",
    message_id: "100000000000000007",
  },
  timestamp: "2026-10-13T11:00:00+00:00",
  content: "Workshop October 20, 2026 at 2:00 PM to 3:00 PM Central Time",
  embeds: [],
  attachments: [],
};
it("production excludes manual chat, other channels/guilds and spoofed names", () => {
  expect(isFollowRelay(post, config)).toBe(true);
  for (const bad of [
    { ...post, flags: 0 },
    { ...post, guild_id: "100000000000000008" },
    { ...post, channel_id: "100000000000000008" },
    { ...post, webhook_id: undefined },
    { ...post, message_reference: undefined },
    { ...post, type: 12 },
  ]) {
    expect(isFollowRelay(bad, config)).toBe(false);
    expect(() => normalizeDiscord(bad, context, config)).toThrow();
  }
});
it("visible text/embeds are projected without profiles, hidden URLs or a manufactured subject", () => {
  const m = normalizeDiscord(
    {
      ...post,
      content: "Hi <@100000000000000009> 🌟",
      author: { username: "private-profile" },
      embeds: [
        {
          title: "Workshop",
          description: "Visible detail",
          url: "https://tracking.invalid/secret",
          fields: [{ name: "When", value: "October 20, 2026" }],
          footer: { text: "hidden-footer" },
          image: { url: "https://tracking.invalid/image" },
        },
      ],
    },
    context,
    config,
  );
  expect(m.content).toBe(
    "Hi @user 🌟\n\nWorkshop\nVisible detail\nWhen: October 20, 2026",
  );
  expect(m.source).toBe("discord");
  expect(m.externalId).toBe(post.id);
  expect(m.receivedAt).toBe("2026-10-13T11:00:00.000Z");
  expect(m.subject).toBeUndefined();
  expect(m.sender).toBeUndefined();
  expect(JSON.stringify(m)).not.toMatch(
    /private-profile|tracking|hidden-footer/,
  );
});
it("manual smoke needs an explicit mode and cannot masquerade as a followed post", () => {
  const manual = {
    ...post,
    flags: 0,
    webhook_id: undefined,
    message_reference: undefined,
  };
  expect(() => normalizeDiscord(manual, context, config)).toThrow();
  expect(
    normalizeDiscord(manual, context, config, "manual-smoke").content,
  ).toContain("Workshop");
  const report = observeMessages([manual], config);
  expect(report.manualReadable).toBe(1);
  expect(report.followedReadable).toBe(0);
  expect(JSON.stringify(report)).not.toContain("Workshop");
  expect(JSON.stringify(report)).not.toContain(post.id);
});
it("missing fields, attachments-only, invalid dates and oversized text are problems, not no-event", () => {
  for (const bad of [
    { ...post, content: undefined },
    {
      ...post,
      content: "",
      embeds: [],
      attachments: [{ url: "https://private.invalid/a" }],
    },
    { ...post, timestamp: "not-a-date" },
    { ...post, content: "x".repeat(262145) },
    { ...post, id: "bad" },
    { ...post, embeds: [{ description: 25 }] },
  ])
    expect(() => normalizeDiscord(bad, context, config)).toThrow();
});
it("optional Discord configuration fails closed and never includes the credential in errors", () => {
  expect(readDiscordConfig({})).toBeNull();
  expect(readDiscordConfig({ DISCORD_BOT_TOKEN: config.token })).toBeNull();
  expect(
    readDiscordConfig({
      DISCORD_BOT_TOKEN: config.token,
      DISCORD_GUILD_ID: config.guildId,
      DISCORD_CHANNEL_IDS: config.channelIds[0],
    }),
  ).toEqual(config);
  expect(
    readDiscordConfig({
      DISCORD_BOT_TOKEN: config.token,
      DISCORD_GUILD_ID: "-1",
      DISCORD_CHANNEL_IDS: config.channelIds[0],
    }),
  ).toBeNull();
});
