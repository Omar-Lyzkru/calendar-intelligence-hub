import { it, expect } from "vitest";
import { projectDispatch } from "./dispatch.js";
const config = {
  token: "synthetic-token-not-real",
  guildId: "800000000000000001",
  channelIds: ["800000000000000002"],
};
const base = {
  id: "800000000000000003",
  guild_id: config.guildId,
  channel_id: config.channelIds[0],
};
it("dispatch crosses the worker boundary with only allowlisted visible source fields", () => {
  const event = {
    t: "MESSAGE_CREATE",
    d: {
      ...base,
      type: 0,
      flags: 2,
      content: "Synthetic announcement",
      timestamp: "2026-10-13T12:00:00Z",
      author: { username: "private-profile" },
      embeds: [
        {
          title: "Visible",
          url: "https://private-hidden",
          fields: [
            {
              name: "When",
              value: "October 20",
              privateExtra: "private-profile",
            },
          ],
        },
      ],
    },
  };
  const projected = projectDispatch(event, config);
  expect(projected).toHaveLength(1);
  expect(JSON.stringify(projected)).not.toContain("private-profile");
  expect(JSON.stringify(projected)).not.toContain("private-hidden");
  expect(JSON.stringify(projected)).toContain("Visible");
  expect(
    projectDispatch(
      { ...event, d: { ...event.d, guild_id: "800000000000000009" } },
      config,
    ),
  ).toEqual([]);
});
it("guild removal stops the feed while own-role changes only recheck permissions", () => {
  expect(
    projectDispatch(
      { t: "GUILD_DELETE", d: { id: config.guildId, unavailable: true } },
      config,
    ),
  ).toEqual([{ kind: "failure", reason: "discord_unavailable" }]);
  expect(
    projectDispatch(
      {
        t: "GUILD_MEMBER_UPDATE",
        d: {
          guild_id: config.guildId,
          user: { id: "800000000000000004" },
          roles: [],
        },
      },
      config,
      "800000000000000004",
    ),
  ).toEqual([{ kind: "permissions" }]);
  expect(
    projectDispatch(
      {
        t: "GUILD_MEMBER_UPDATE",
        d: { guild_id: config.guildId, user: { id: "800000000000000005" } },
      },
      config,
      "800000000000000004",
    ),
  ).toEqual([]);
});
it("bulk deletes and oversized dispatch stay bounded", () => {
  const deletes = projectDispatch(
    { t: "MESSAGE_DELETE_BULK", d: { ...base, ids: Array(101).fill(base.id) } },
    config,
  );
  expect(deletes).toHaveLength(100);
  expect(
    projectDispatch(
      { t: "MESSAGE_CREATE", d: { ...base, content: "x".repeat(1048577) } },
      config,
    ),
  ).toEqual([{ kind: "failure", reason: "discord_invalid_payload" }]);
});
