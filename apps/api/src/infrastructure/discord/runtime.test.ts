import { it, expect, vi, afterEach } from "vitest";
import { AppError } from "@hub/contracts";
import {
  DiscordRuntime,
  type DiscordTransport,
  type DiscordEvent,
} from "./runtime.js";
const config = {
  token: "synthetic-token-not-real",
  guildId: "800000000000000001",
  channelIds: ["800000000000000002"],
};
const post = {
  id: "800000000000000003",
  guild_id: config.guildId,
  channel_id: config.channelIds[0],
  type: 0,
  flags: 2,
  webhook_id: "800000000000000004",
  message_reference: {
    guild_id: "800000000000000005",
    channel_id: "800000000000000006",
    message_id: "800000000000000007",
  },
  timestamp: "2026-10-13T12:00:00Z",
  content: "Workshop October 20, 2026 at 2:00 PM",
  embeds: [],
};
function harness(
  options: {
    access?: () => Promise<void>;
    binding?: () => Promise<{ generation: number } | null>;
    sink?: (p: unknown, g: number) => Promise<void>;
  } = {},
) {
  let handler: (e: DiscordEvent) => void = () => {};
  let stopped = false;
  const imported: unknown[] = [];
  const changes: unknown[] = [];
  const reads: string[] = [];
  const transport: DiscordTransport = {
    start: async (h) => {
      handler = h;
    },
    stop: async () => {
      stopped = true;
    },
  };
  const runtime = new DiscordRuntime(
    config,
    {
      checkAccess: options.access || (async () => {}),
      getMessages: async (id) => {
        reads.push(id);
        return [post];
      },
      getMessage: async () => post,
    },
    transport,
    {
      binding: options.binding || (async () => ({ generation: 7 })),
      ingest:
        options.sink ||
        (async (p, g) => {
          imported.push({ p, g });
        }),
      change: async (e) => {
        changes.push(e);
      },
    },
  );
  return {
    runtime,
    emit: (e: DiscordEvent) => handler(e),
    imported,
    changes,
    reads,
    isStopped: () => stopped,
  };
}
afterEach(() => vi.useRealTimers());
it("configuration alone never allocates a workspace or starts recovery without an owned binding", async () => {
  const h = harness({ binding: async () => null });
  await h.runtime.start();
  expect(h.runtime.status().state).toBe("idle");
  expect(h.reads).toEqual([]);
});
it("fresh ready recovers one capped allowlisted window, resumed sessions do not repeat recovery", async () => {
  const h = harness();
  await h.runtime.start();
  h.emit({ kind: "ready" });
  await vi.waitFor(() => expect(h.imported).toHaveLength(1));
  expect(h.reads).toEqual(config.channelIds);
  expect(h.runtime.status()).toMatchObject({
    state: "connected",
    coverage: "capped",
  });
  h.emit({ kind: "resumed" });
  await new Promise((r) => setTimeout(r, 10));
  expect(h.reads).toHaveLength(1);
  h.emit({ kind: "ready" });
  await vi.waitFor(() => expect(h.reads).toHaveLength(2));
  await h.runtime.stop();
});
it("production ignores ordinary chat and foreign IDs while edits fetch only a validated selected message", async () => {
  const h = harness();
  await h.runtime.start();
  h.emit({ kind: "create", payload: { ...post, flags: 0 } });
  h.emit({
    kind: "create",
    payload: { ...post, guild_id: "800000000000000009" },
  });
  h.emit({
    kind: "update",
    payload: {
      id: post.id,
      guild_id: config.guildId,
      channel_id: config.channelIds[0],
    },
  });
  await vi.waitFor(() => expect(h.imported).toHaveLength(1));
  expect(h.imported[0]).toEqual({ p: post, g: 7 });
  expect(h.changes).toEqual([]);
  await h.runtime.stop();
});
it("throttled or lost permissions are safe provider failures, never false empty coverage", async () => {
  const failure = new AppError("discord_rate_limited", 429);
  failure.retryAfterSeconds = 3;
  const h = harness({
    access: async () => {
      throw failure;
    },
  });
  await h.runtime.start();
  expect(h.runtime.status()).toMatchObject({
    state: "blocked",
    reason: "discord_rate_limited",
    retryAfterSeconds: 3,
    coverage: "incomplete",
  });
  expect(h.reads).toEqual([]);
});
it("queue overflow stays bounded and reports incomplete coverage", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const received: unknown[] = [];
  const h = harness({
    sink: async (p) => {
      await gate;
      received.push(p);
    },
  });
  await h.runtime.start();
  h.emit({ kind: "create", payload: post });
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 110; i++) h.emit({ kind: "create", payload: post });
  expect(h.runtime.status()).toMatchObject({
    coverage: "incomplete",
    reason: "discord_queue_overflow",
  });
  release();
  await vi.waitFor(() => expect(received.length).toBe(101));
  await h.runtime.stop();
});
it("disconnect discards queued work and never persists a read finishing after stop", async () => {
  let release!: () => void;
  const access = new Promise<void>((r) => (release = r));
  let count = 0;
  const h = harness({
    access: async () => {
      if (++count > 1) await access;
    },
  });
  await h.runtime.start();
  h.emit({ kind: "create", payload: post });
  await new Promise((r) => setTimeout(r, 5));
  h.emit({ kind: "create", payload: post });
  await h.runtime.stop();
  release();
  await new Promise((r) => setTimeout(r, 10));
  expect(h.imported).toEqual([]);
  expect(h.isStopped()).toBe(true);
});
it("unrecoverable transport problems stop reads and preserve an actionable status", async () => {
  const h = harness();
  await h.runtime.start();
  h.emit({ kind: "failure", reason: "discord_intent_required" });
  await vi.waitFor(() => expect(h.isStopped()).toBe(true));
  expect(h.runtime.status()).toMatchObject({
    state: "blocked",
    reason: "discord_intent_required",
    coverage: "incomplete",
  });
  h.emit({ kind: "create", payload: post });
  expect(h.imported).toEqual([]);
});
it("lost content intent and excessive permissions remain explicit setup failures", async () => {
  for (const code of [
    "discord_content_intent_required",
    "discord_permissions_excessive",
  ]) {
    const h = harness({
      access: async () => {
        throw new AppError(code, 403);
      },
    });
    await h.runtime.start();
    expect(h.runtime.status()).toMatchObject({
      state: "blocked",
      reason: code,
      coverage: "incomplete",
    });
  }
});
it("permission loss after connection stops subsequent imports", async () => {
  let calls = 0;
  const h = harness({
    access: async () => {
      if (++calls > 1) throw new AppError("discord_permissions_required", 403);
    },
  });
  await h.runtime.start();
  h.emit({ kind: "permissions" });
  await vi.waitFor(() => expect(h.runtime.status().state).toBe("blocked"));
  h.emit({ kind: "create", payload: post });
  expect(h.imported).toEqual([]);
});
