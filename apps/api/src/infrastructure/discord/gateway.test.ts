import { EventEmitter } from "node:events";
import { it, expect, vi, afterEach } from "vitest";
import { gatewayTransport } from "./gateway.js";
class Port extends EventEmitter {
  terminated = false;
  async terminate() {
    this.terminated = true;
    return 0;
  }
}
afterEach(() => vi.useRealTimers());
const config = {
  token: "synthetic-token-not-real",
  guildId: "800000000000000001",
  channelIds: ["800000000000000002"],
};
it("bounded reconnect failures terminate the isolated SDK worker and discard late dispatch", async () => {
  const port = new Port();
  const events: unknown[] = [];
  const transport = gatewayTransport(config, () => port);
  await transport.start((e) => events.push(e));
  for (let i = 0; i < 6; i++)
    port.emit("message", { kind: "closed", code: 1006 });
  await new Promise((r) => setTimeout(r, 0));
  expect(port.terminated).toBe(true);
  expect(events.at(-1)).toMatchObject({
    kind: "failure",
    reason: "discord_reconnect_exhausted",
  });
  const length = events.length;
  port.emit("message", { kind: "ready" });
  expect(events).toHaveLength(length);
});
it("intent denial and worker crashes become sanitized errors without exposing their payloads", async () => {
  for (const kind of ["intent", "crash"]) {
    const port = new Port();
    const events: unknown[] = [];
    const transport = gatewayTransport(config, () => port);
    await transport.start((e) => events.push(e));
    if (kind === "intent") port.emit("message", { kind: "closed", code: 4014 });
    else port.emit("error", new Error("private token never echo"));
    await new Promise((r) => setTimeout(r, 0));
    expect(port.terminated).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private token");
    expect(events.at(-1)).toMatchObject({ kind: "failure" });
  }
});
it("normal stop terminates SDK retries, detaches delivery and is idempotent", async () => {
  const port = new Port();
  const events: unknown[] = [];
  const transport = gatewayTransport(config, () => port);
  await transport.start((e) => events.push(e));
  await transport.stop();
  await transport.stop();
  port.emit("message", { kind: "create", payload: { secret: "not emitted" } });
  expect(events).toEqual([]);
  expect(port.terminated).toBe(true);
});

it("SDK heartbeat/reconnect resume closes count toward the finite retry budget", async () => {
  const port = new Port(),
    events: unknown[] = [];
  const transport = gatewayTransport(config, () => port);
  await transport.start((e) => events.push(e));
  port.emit("message", { kind: "ready" });
  for (let i = 0; i < 6; i++)
    port.emit("message", { kind: "closed", code: 4200 });
  await new Promise((r) => setTimeout(r, 0));
  expect(port.terminated).toBe(true);
  expect(events.at(-1)).toMatchObject({
    kind: "failure",
    reason: "discord_reconnect_exhausted",
  });
});
it("resume after readiness gets a new deadline instead of remaining falsely connected", async () => {
  vi.useFakeTimers();
  const port = new Port(),
    events: unknown[] = [];
  const transport = gatewayTransport(config, () => port);
  await transport.start((e) => events.push(e));
  port.emit("message", { kind: "ready" });
  port.emit("message", { kind: "closed", code: 4200 });
  expect(events.at(-1)).toEqual({ kind: "reconnecting" });
  await vi.advanceTimersByTimeAsync(44999);
  expect(port.terminated).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(port.terminated).toBe(true);
  expect(events.at(-1)).toMatchObject({
    kind: "failure",
    reason: "discord_session_unavailable",
  });
});
it("a successful SDK resume cancels its deadline and continues delivery", async () => {
  vi.useFakeTimers();
  const port = new Port(),
    events: unknown[] = [];
  const transport = gatewayTransport(config, () => port);
  await transport.start((e) => events.push(e));
  port.emit("message", { kind: "ready" });
  port.emit("message", { kind: "closed", code: 4200 });
  await vi.advanceTimersByTimeAsync(20000);
  port.emit("message", { kind: "resumed" });
  await vi.advanceTimersByTimeAsync(60000);
  expect(port.terminated).toBe(false);
  expect(events.at(-1)).toEqual({ kind: "resumed" });
  await transport.stop();
});
