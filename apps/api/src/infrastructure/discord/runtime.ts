import { AppError } from "@hub/contracts";
import type { DiscordConfig } from "./config.js";
import { isSnowflake } from "./config.js";
import { isFollowRelay, normalizeDiscord } from "./normalize.js";
export type DiscordEvent =
  | { kind: "ready" | "resumed" | "permissions" | "reconnecting" }
  | { kind: "create" | "update" | "delete"; payload: unknown }
  | { kind: "failure"; reason: string };
export interface DiscordTransport {
  start(onEvent: (event: DiscordEvent) => void): Promise<void>;
  stop(): Promise<void>;
}
export interface DiscordRuntimeStatus {
  state: "idle" | "connecting" | "connected" | "blocked";
  coverage: "not_checked" | "capped" | "incomplete";
  reason?: string;
  retryAfterSeconds?: number;
}
interface Rest {
  checkAccess(): Promise<unknown>;
  getMessages(channelId: string): Promise<Record<string, unknown>[]>;
  getMessage(channelId: string, id: string): Promise<Record<string, unknown>>;
}
interface Store {
  binding(): Promise<{ generation: number } | null>;
  ingest(payload: unknown, generation: number): Promise<unknown>;
  change(
    event: { kind: "update" | "delete"; payload: unknown },
    generation: number,
  ): Promise<unknown>;
}
const safeReasons = new Set([
  "discord_content_intent_required",
  "discord_permissions_excessive",
  "discord_token_invalid",
  "discord_permissions_required",
  "discord_intent_required",
  "discord_source_missing",
  "discord_rate_limited",
  "discord_unavailable",
  "discord_invalid_payload",
  "discord_queue_overflow",
  "discord_reconnect_exhausted",
  "discord_session_unavailable",
]);
export class DiscordRuntime {
  private epoch = 0;
  private active = false;
  private generation = 0;
  private running = false;
  private queue: Array<() => Promise<void>> = [];
  private current: DiscordRuntimeStatus = {
    state: "idle",
    coverage: "not_checked",
  };
  constructor(
    private config: DiscordConfig,
    private rest: Rest,
    private transport: DiscordTransport,
    private store: Store,
  ) {}
  status(): DiscordRuntimeStatus {
    return { ...this.current };
  }
  async start() {
    if (this.active) return;
    const epoch = ++this.epoch;
    this.active = true;
    this.current = { state: "connecting", coverage: "not_checked" };
    try {
      const binding = await this.store.binding();
      if (!this.valid(epoch)) return;
      if (!binding) {
        this.active = false;
        this.current = { state: "idle", coverage: "not_checked" };
        return;
      }
      this.generation = binding.generation;
      await this.rest.checkAccess();
      if (!this.valid(epoch)) return;
      await this.transport.start((event) => this.onEvent(event, epoch));
      if (!this.valid(epoch)) await this.transport.stop();
    } catch (error) {
      if (this.valid(epoch)) await this.fail(error);
    }
  }
  async stop() {
    ++this.epoch;
    this.active = false;
    this.queue = [];
    this.current = { state: "idle", coverage: "not_checked" };
    await this.transport.stop();
  }
  async reconnect() {
    await this.stop();
    await this.start();
  }
  private valid(epoch: number) {
    return this.active && this.epoch === epoch;
  }
  private async fail(error: unknown) {
    const reason =
      error instanceof AppError && safeReasons.has(error.code)
        ? error.code
        : typeof error === "string" && safeReasons.has(error)
          ? error
          : "discord_unavailable";
    const retry =
      error instanceof AppError ? error.retryAfterSeconds : undefined;
    ++this.epoch;
    this.active = false;
    this.queue = [];
    this.current = {
      state: "blocked",
      coverage: "incomplete",
      reason,
      ...(retry ? { retryAfterSeconds: retry } : {}),
    };
    await this.transport.stop().catch(() => {});
  }
  private enqueue(job: () => Promise<void>, epoch: number) {
    if (!this.valid(epoch)) return;
    if (this.queue.length >= 100) {
      this.current = {
        ...this.current,
        coverage: "incomplete",
        reason: "discord_queue_overflow",
      };
      return;
    }
    this.queue.push(job);
    void this.drain();
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.active && this.queue.length) {
        const epoch = this.epoch;
        const job = this.queue.shift()!;
        try {
          await job();
        } catch (error) {
          if (this.valid(epoch)) await this.fail(error);
        }
      }
    } finally {
      this.running = false;
      if (this.active && this.queue.length) void this.drain();
    }
  }
  private onEvent(event: DiscordEvent, epoch: number) {
    if (!this.valid(epoch)) return;
    if (event.kind === "failure") {
      void this.fail(event.reason);
      return;
    }
    if (event.kind === "reconnecting") {
      this.current = {
        ...this.current,
        state: "connecting",
        coverage: "incomplete",
      };
      return;
    }
    if (event.kind === "resumed") {
      this.current = { ...this.current, state: "connected" };
      return;
    }
    if (event.kind === "ready") {
      this.current = { ...this.current, state: "connected" };
      this.enqueue(async () => {
        await this.rest.checkAccess();
        if (!this.valid(epoch)) return;
        for (const channel of this.config.channelIds) {
          const messages = await this.rest.getMessages(channel);
          if (!this.valid(epoch)) return;
          if (messages.length > 100)
            throw new AppError("discord_invalid_payload", 502);
          for (const payload of messages) {
            if (!this.valid(epoch)) return;
            if (isFollowRelay(payload, this.config))
              await this.store.ingest(payload, this.generation);
          }
        }
        if (this.valid(epoch) && this.current.coverage !== "incomplete")
          this.current.coverage = "capped";
      }, epoch);
      return;
    }
    if (event.kind === "permissions") {
      this.enqueue(async () => {
        await this.rest.checkAccess();
      }, epoch);
      return;
    }
    if (!("payload" in event)) return;
    const payload = event.payload as Record<string, unknown> | null;
    if (
      !payload ||
      payload.guild_id !== this.config.guildId ||
      typeof payload.channel_id !== "string" ||
      !this.config.channelIds.includes(payload.channel_id) ||
      !isSnowflake(payload.id)
    )
      return;
    if (event.kind === "create") {
      if (!isFollowRelay(payload, this.config)) return;
      // Bound queued source text before retaining it; malformed Follow posts still get a durable safe failure receipt.
      try {
        normalizeDiscord(
          payload,
          {
            id: "budget",
            userId: "budget",
            sourceConnectionId: "budget",
            ingestedAt: new Date().toISOString(),
          },
          this.config,
        );
      } catch {
        if (Buffer.byteLength(JSON.stringify(payload)) > 1048576) {
          void this.fail("discord_invalid_payload");
          return;
        }
      }
    }
    this.enqueue(async () => {
      await this.rest.checkAccess();
      if (!this.valid(epoch)) return;
      if (event.kind === "create")
        await this.store.ingest(payload, this.generation);
      else if (event.kind === "delete")
        await this.store.change({ kind: "delete", payload }, this.generation);
      else {
        let full;
        try {
          full = await this.rest.getMessage(
            payload.channel_id as string,
            payload.id as string,
          );
        } catch (error) {
          if (
            error instanceof AppError &&
            error.code === "discord_source_missing"
          ) {
            if (this.valid(epoch))
              await this.store.change(
                { kind: "delete", payload },
                this.generation,
              );
            return;
          }
          throw error;
        }
        if (this.valid(epoch)) {
          if (isFollowRelay(full, this.config))
            await this.store.ingest(full, this.generation);
          else
            await this.store.change(
              { kind: "update", payload: full },
              this.generation,
            );
        }
      }
    }, epoch);
  }
}
