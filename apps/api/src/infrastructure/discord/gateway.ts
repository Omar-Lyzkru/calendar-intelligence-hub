import { Worker } from "node:worker_threads";
import type { DiscordConfig } from "./config.js";
import type { DiscordEvent, DiscordTransport } from "./runtime.js";
interface Port {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
  terminate(): Promise<number>;
}
export function gatewayTransport(
  config: DiscordConfig,
  create: (config: DiscordConfig) => Port = (c) =>
    new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./gatewayWorker.ts"
          : "./gatewayWorker.js",
        import.meta.url,
      ),
      {
        workerData: c,
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 96 },
      },
    ),
): DiscordTransport {
  let port: Port | null = null;
  let readyDeadline: ReturnType<typeof setTimeout> | undefined;
  const stop = async () => {
    if (readyDeadline) clearTimeout(readyDeadline);
    const old = port;
    port = null;
    if (old) {
      old.removeAllListeners("message");
      await old.terminate();
      old.removeAllListeners();
    }
  };
  return {
    stop,
    async start(deliver) {
      await stop();
      const current = create(config);
      port = current;
      const closed: number[] = [];
      const fail = (reason: string) => {
        if (port !== current) return;
        deliver({ kind: "failure", reason });
        void stop().catch(() => {});
      };
      // Worker stdout/stderr are intentionally consumed without relaying SDK/private error text.
      const worker = current as Worker;
      worker.stdout?.resume();
      worker.stderr?.resume();
      readyDeadline = setTimeout(
        () => fail("discord_session_unavailable"),
        45000,
      );
      readyDeadline.unref();
      current.on("error", () => fail("discord_unavailable"));
      current.on("exit", () => fail("discord_unavailable"));
      current.on("message", (message: Record<string, unknown>) => {
        if (port !== current || !message || typeof message.kind !== "string")
          return;
        if (message.kind === "closed") {
          const code = Number(message.code);
          if (code === 4014 || code === 4013) {
            fail("discord_intent_required");
            return;
          }
          if (code === 4004) {
            fail("discord_token_invalid");
            return;
          }
          if ([4010, 4011, 4012].includes(code)) {
            fail("discord_session_unavailable");
            return;
          }
          const now = Date.now();
          closed.push(now);
          while (closed.length && closed[0] < now - 300000) closed.shift();
          if (closed.length > 5) fail("discord_reconnect_exhausted");
          else {
            deliver({ kind: "reconnecting" });
            if (readyDeadline) clearTimeout(readyDeadline);
            readyDeadline = setTimeout(
              () => fail("discord_session_unavailable"),
              45000,
            );
            readyDeadline.unref();
          }
          return;
        }
        if (message.kind === "ready" || message.kind === "resumed") {
          if (readyDeadline) clearTimeout(readyDeadline);
          deliver({ kind: message.kind });
          return;
        }
        if (message.kind === "permissions") {
          deliver({ kind: "permissions" });
          return;
        }
        if (["create", "update", "delete"].includes(message.kind))
          deliver({
            kind: message.kind,
            payload: message.payload,
          } as DiscordEvent);
        if (message.kind === "failure")
          fail(
            message.reason === "discord_invalid_payload"
              ? "discord_invalid_payload"
              : "discord_unavailable",
          );
      });
    },
  };
}
