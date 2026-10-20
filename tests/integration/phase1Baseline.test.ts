import { it, expect, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import request from "supertest";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { fixture } from "./helpers.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import {
  saveReview,
  approveReview,
} from "../../apps/api/src/application/approveReview.js";
import { createApp } from "../../apps/api/src/app.js";
import { OAuthService } from "../../apps/api/src/infrastructure/google/oauth.js";
import { createSession } from "../../apps/api/src/infrastructure/sessions/store.js";
import { AppError } from "@hub/contracts";
const config = {
  NODE_ENV: "test" as const,
  PORT: 43174,
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: process.env.DATABASE_URL!,
  GOOGLE_CLIENT_ID: "synthetic-client",
  GOOGLE_CLIENT_SECRET: "synthetic-client-secret",
  GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
  TOKEN_ENCRYPTION_KEY: "1".repeat(64),
  PROVIDER_TIMEOUT_MS: 15000,
};
afterAll(() => db.$disconnect());
it("real_startup_erases_expired_source_and_preserves_reviewed_facts", async () => {
  const items = [];
  for (const kind of ["unresolved", "corrected", "approved", "unexpired"]) {
    const f = await fixture();
    const message = {
      ...f.message,
      content:
        kind === "unresolved" ? "Workshop after class" : f.message.content,
    };
    const imported = await saveProcessedMessage(
      f.actor,
      message,
      processMessage(message, "America/Chicago"),
    );
    const draft = {
      title: "Synthetic preserved commitment",
      location: null,
      description: null,
      category: "event" as const,
      temporal: {
        kind: "all_day" as const,
        startDate: "2026-10-20",
        endExclusive: "2026-10-21",
      },
    };
    if (kind === "corrected" || kind === "approved") {
      const saved = await saveReview(f.actor, imported.reviewId!, 1, draft);
      if (kind === "approved")
        await approveReview(f.actor, imported.reviewId!, saved.revision);
    }
    await db.normalizedMessage.update({
      where: { id: message.id },
      data: {
        expiresAt:
          kind === "unexpired" ? new Date(Date.now() + 86400000) : new Date(0),
      },
    });
    items.push({ kind, f, id: imported.reviewId! });
  }
  let output = "";
  const child = spawn(process.execPath, ["dist/apps/api/src/server.js"], {
    env: {
      ...process.env,
      ...config,
      PORT: String(config.PORT),
      PROVIDER_TIMEOUT_MS: String(config.PROVIDER_TIMEOUT_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  try {
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        ready = (await fetch("http://127.0.0.1:" + config.PORT + "/api/health"))
          .ok;
      } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(ready).toBe(true);
    for (const item of items) {
      const m = await db.normalizedMessage.findUniqueOrThrow({
        where: { id: item.f.message.id },
        include: { detected: { include: { review: true } } },
      });
      expect(m.content !== null).toBe(item.kind === "unexpired");
      if (item.kind !== "unexpired") {
        const c = m.detected!.candidate as any;
        expect(
          c.evidence.every(
            (e: any) =>
              e.text === undefined &&
              e.start === undefined &&
              e.end === undefined,
          ),
        ).toBe(true);
      }
      if (item.kind === "unresolved")
        expect((m.detected!.review!.draft as any).temporal.text).toBe("");
      if (item.kind === "corrected" || item.kind === "approved")
        expect((m.detected!.review!.draft as any).title).toBe(
          "Synthetic preserved commitment",
        );
      if (item.kind === "approved")
        expect(
          (m.detected!.review!.approvedSnapshot as any).temporal.startDate,
        ).toBe("2026-10-20");
    }
    expect(output).toContain("server_started");
    expect(output).not.toContain(config.GOOGLE_CLIENT_SECRET);
    expect(output).not.toContain(config.TOKEN_ENCRYPTION_KEY);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null)
      await new Promise<void>((r) => child.once("exit", () => r()));
    for (const item of items)
      await db.user.delete({ where: { id: item.f.user.id } });
  }
}, 15000);
it("HTTP_error_logging_excludes_sensitive_sentinels_across_failure_paths", async () => {
  const sentinel = "SENSITIVE_SYNTHETIC_SENTINEL_42";
  const logs: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args) => logs.push(args.join(" ")));
  const f = await fixture(),
    session = await createSession(f.user.id);
  let nonce = "";
  let mode = "identity";
  const oauth = new OAuthService(config, {
    authorizationUrl: (p) => {
      nonce = p.nonce;
      return "https://accounts.google.com/?state=" + p.state;
    },
    exchange: async () => {
      if (mode === "identity") throw Error(sentinel);
      return {
        idToken: sentinel,
        refreshToken: sentinel,
        scope: "openid email profile",
      };
    },
    verify: async () => ({
      sub: f.user.googleSubject,
      email: f.user.email,
      nonce,
    }),
  });
  const app = createApp({
    config,
    oauth,
    gmail: {
      list: async () => {
        throw Error(sentinel);
      },
      get: async () => {
        throw Error(sentinel);
      },
    },
  });
  const cookie = "hub_session=" + session.token;
  try {
    let r = await request(app)
      .get("/auth/google/callback")
      .set("Cookie", cookie)
      .query({ state: sentinel, code: sentinel });
    expect(r.body.error.code).toBe("invalid_state");
    for (mode of ["identity", "scope"]) {
      const start = await oauth.startAuthorization("gmail", session.token);
      r = await request(app)
        .get("/auth/google/callback")
        .set("Cookie", cookie)
        .query({
          state: new URL(start.url).searchParams.get("state"),
          code: sentinel,
        });
      expect(r.body.error.code).toBe(
        mode === "identity" ? "invalid_identity" : "scope_not_granted",
      );
    }
    r = await request(app).get("/api/gmail/messages").set("Cookie", cookie);
    expect(r.status).toBe(500);
    const me = await request(app).get("/api/me").set("Cookie", cookie);
    r = await request(app)
      .patch("/api/me")
      .set("Cookie", cookie)
      .set("Origin", config.APP_ORIGIN)
      .set("x-csrf-token", me.body.csrf)
      .send({ timezone: sentinel });
    expect(r.status).toBe(422);
    // Real middleware must also hide provider AppError messages.
    const provider = createApp({
      config,
      gmail: {
        list: async () => {
          throw Object.assign(new AppError("provider_unavailable", 503), {
            message: sentinel,
          });
        },
        get: async () => {
          throw Error(sentinel);
        },
      },
    });
    expect(
      (await request(provider).get("/api/gmail/messages").set("Cookie", cookie))
        .status,
    ).toBe(503);
    expect(logs.length).toBeGreaterThanOrEqual(6);
    for (const log of logs) {
      const parsed = JSON.parse(log);
      expect(Object.keys(parsed).sort()).toEqual([
        "code",
        "requestId",
        "status",
      ]);
      expect(log).not.toContain(sentinel);
      expect(log).not.toContain(session.token);
      expect(log).not.toContain(config.GOOGLE_CLIENT_SECRET);
    }
  } finally {
    spy.mockRestore();
    await db.user.delete({ where: { id: f.user.id } });
  }
});
