import { it, expect, vi, afterEach } from "vitest";
import { DiscordRest } from "./rest.js";
const config = {
  token: "synthetic-discord-token-only",
  guildId: "100000000000000001",
  channelIds: ["100000000000000002"],
};
afterEach(() => vi.unstubAllGlobals());
it("only configured destination reads use fixed GET routes and reject foreign IDs before a request", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(
      url.endsWith("/" + config.channelIds[0])
        ? { id: config.channelIds[0], guild_id: config.guildId, type: 0 }
        : {
            id: "100000000000000003",
            channel_id: config.channelIds[0],
            content: "synthetic",
          },
    );
  });
  const rest = new DiscordRest(config, 1000);
  await rest.getMessage(config.channelIds[0], "100000000000000003");
  expect(calls[1].url).toBe(
    "https://discord.com/api/v10/channels/100000000000000002/messages/100000000000000003",
  );
  expect(calls[0].init.method).toBe("GET");
  expect(calls[0].init.redirect).toBe("error");
  expect(calls[0].init.headers).toMatchObject({
    Authorization: "Bot synthetic-discord-token-only",
  });
  await expect(rest.getMessages("100000000000000009")).rejects.toMatchObject({
    code: "discord_invalid_source",
  });
  expect(calls.length).toBe(2);
});
it("history stays capped and validates channel metadata rather than treating missing history access as empty", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return Response.json(
      url.includes("?limit=")
        ? []
        : { id: config.channelIds[0], guild_id: config.guildId, type: 0 },
    );
  });
  const rest = new DiscordRest(config, 1000);
  await rest.getMessages(config.channelIds[0]);
  expect(calls[1]).toBe(
    "https://discord.com/api/v10/channels/100000000000000002/messages?limit=100",
  );
  vi.stubGlobal("fetch", async () =>
    Response.json({ guild_id: "100000000000000009", type: 0 }),
  );
  await expect(rest.getChannel(config.channelIds[0])).rejects.toMatchObject({
    code: "discord_invalid_source",
  });
});
it.each([401, 403, 429, 500])(
  "HTTP %s never exposes raw response, credentials or headers",
  async (status) => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { message: "private-provider-diagnostic", retry_after: 1.2 },
        { status, headers: { "retry-after": "1.2" } },
      ),
    );
    const rest = new DiscordRest(config, 1000);
    try {
      await rest.getMessages(config.channelIds[0]);
      throw Error("expected rejection");
    } catch (e) {
      const error = e as { code: string; retryAfterSeconds?: number };
      expect(error.code).toBe(
        status === 401
          ? "discord_token_invalid"
          : status === 403
            ? "discord_permissions_required"
            : status === 429
              ? "discord_rate_limited"
              : "discord_unavailable",
      );
      if (status === 429) expect(error.retryAfterSeconds).toBe(2);
      expect(String(e)).not.toMatch(/private-provider|synthetic-discord-token/);
    }
  },
);
it("oversize/malformed responses and network errors fail safely", async () => {
  const rest = new DiscordRest(config, 1000);
  for (const reply of [
    new Response("x".repeat(1048577)),
    new Response("not-json"),
  ]) {
    vi.stubGlobal("fetch", async () => reply);
    await expect(rest.getMessages(config.channelIds[0])).rejects.toBeDefined();
  }
  vi.stubGlobal("fetch", async () => {
    throw Error("private-url-and-secret");
  });
  await expect(rest.getMessages(config.channelIds[0])).rejects.toMatchObject({
    code: "discord_unavailable",
  });
});
it("access verification checks own bot only, enabled content intent and effective read-only channel permissions", async () => {
  const calls: string[] = [];
  const response = (url: string) => {
    if (url.endsWith("oauth2/applications/@me")) return { flags: 524288 };
    if (url.endsWith("users/@me"))
      return { id: "100000000000000010", username: "synthetic-bot" };
    if (url.endsWith("/roles"))
      return [
        { id: config.guildId, permissions: "0" },
        { id: "100000000000000011", permissions: "66560" },
      ];
    if (url.includes("/members/")) return { roles: ["100000000000000011"] };
    return {
      id: config.channelIds[0],
      guild_id: config.guildId,
      type: 0,
      permission_overwrites: [],
    };
  };
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return Response.json(response(url));
  });
  const rest = new DiscordRest(config, 1000);
  await expect(rest.checkAccess()).resolves.toBeUndefined();
  expect(calls.some((c) => c.endsWith("/members"))).toBe(false);
  expect(calls.filter((c) => c.includes("/members/")).length).toBe(1);
  vi.stubGlobal("fetch", async (url: string) =>
    Response.json(
      url.endsWith("oauth2/applications/@me") ? { flags: 0 } : response(url),
    ),
  );
  await expect(rest.checkAccess()).rejects.toMatchObject({
    code: "discord_content_intent_required",
  });
  vi.stubGlobal("fetch", async (url: string) =>
    Response.json(
      url.endsWith("/roles")
        ? [
            { id: config.guildId, permissions: "2048" },
            { id: "100000000000000011", permissions: "66560" },
          ]
        : response(url),
    ),
  );
  await expect(rest.checkAccess()).rejects.toMatchObject({
    code: "discord_permissions_excessive",
    permissionChanges: ["Send Messages"],
    scope: "feed",
  });
});
