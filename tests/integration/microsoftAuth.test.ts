import { it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { MicrosoftOAuthService } from "../../apps/api/src/infrastructure/microsoft/oauth.js";
import type {
  MicrosoftGateway,
  MicrosoftTokenResult,
} from "../../apps/api/src/infrastructure/microsoft/gateway.js";
import {
  createSession,
  readSession,
} from "../../apps/api/src/infrastructure/sessions/store.js";
import { decryptToken } from "../../apps/api/src/infrastructure/google/tokenVault.js";
import { createApp } from "../../apps/api/src/app.js";
import { AppError } from "@hub/contracts";
import { fixture } from "./helpers.js";
const tenant = "22222222-2222-4222-8222-222222222222",
  account = "33333333-3333-4333-8333-333333333333";
const config = {
  NODE_ENV: "test" as const,
  PORT: 3000,
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: process.env.DATABASE_URL!,
  GOOGLE_CLIENT_ID: "synthetic",
  GOOGLE_CLIENT_SECRET: "synthetic",
  GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
  TOKEN_ENCRYPTION_KEY: "1".repeat(64),
  PROVIDER_TIMEOUT_MS: 15000,
  MICROSOFT_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
  MICROSOFT_TENANT_ID: tenant,
  MICROSOFT_CLIENT_SECRET: "synthetic-secret",
  MICROSOFT_REDIRECT_URI: "http://localhost:5173/auth/microsoft/callback",
};
const cache = JSON.stringify({
  RefreshToken: { synthetic: { secret: "synthetic-refresh-only" } },
});
function harness() {
  let parameters: Record<string, string> = {};
  let change: (r: MicrosoftTokenResult) => MicrosoftTokenResult = (r) => r;
  let fail: unknown;
  let pause: Promise<void> | undefined;
  const result = (): MicrosoftTokenResult => ({
    cache,
    accessToken: "synthetic-access-only",
    scopes: ["Mail.Read"],
    refreshCapable: true,
    identity: {
      tenantId: tenant,
      accountId: account,
      nonce: parameters.nonce,
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      audience: config.MICROSOFT_CLIENT_ID,
      expiresAt: Date.now() + 3600000,
    },
  });
  const gateway: MicrosoftGateway = {
    authorizationUrl: async (p) => {
      parameters = p;
      return (
        "https://login.microsoftonline.com/" +
        tenant +
        "/oauth2/v2.0/authorize?" +
        new URLSearchParams(p)
      );
    },
    exchange: async () => {
      if (pause) await pause;
      if (fail) throw fail;
      return change(result());
    },
    access: async () => {
      if (pause) await pause;
      if (fail) throw fail;
      return change(result());
    },
  };
  return {
    service: new MicrosoftOAuthService(config, gateway),
    parameters: () => parameters,
    change: (fn: typeof change) => {
      change = fn;
    },
    fail: (e: unknown) => {
      fail = e;
    },
    pause: (p: Promise<void>) => {
      pause = p;
    },
  };
}
async function begin(h = harness()) {
  const f = await fixture();
  const session = await createSession(f.user.id);
  const started = await h.service.startAuthorization(session.token);
  const state = new URL(started.url).searchParams.get("state")!;
  return { ...f, session, state, h };
}
async function connected() {
  const f = await begin();
  const done = await f.h.service.completeAuthorization(
    { state: f.state, code: "synthetic-code" },
    f.session.token,
  );
  return { ...f, token: done.token };
}
afterAll(() => db.$disconnect());
it("Microsoft start requires workspace identity even when configured", async () => {
  const session = await createSession();
  await expect(
    harness().service.startAuthorization(session.token),
  ).rejects.toMatchObject({ code: "authentication_required" });
});
it("start stores hashed, session-bound state and S256 PKCE without exposing verifier", async () => {
  const f = await begin();
  const row = await db.oAuthState.findFirst({
    where: { sessionId: f.session.id },
  });
  expect(row!.stateHash).not.toBe(f.state);
  expect(row!.verifier.length).toBeGreaterThanOrEqual(43);
  expect(row!.intent).toBe("microsoft");
  const p = f.h.parameters();
  expect(p.code_challenge_method).toBe("S256");
  expect(p.code_challenge).not.toBe(row!.verifier);
  expect(new URLSearchParams(p).toString()).not.toContain(row!.verifier);
});
it("callback encrypts refresh cache, preserves workspace user and rotates session", async () => {
  const f = await connected();
  const auth = await db.microsoftAuthorization.findUnique({
    where: { userId: f.user.id },
  });
  expect(auth).toMatchObject({
    tenantId: tenant,
    accountId: account,
    status: "connected",
  });
  expect(auth!.tokenCache).not.toContain("synthetic-refresh-only");
  expect(decryptToken(auth!.tokenCache!, config.TOKEN_ENCRYPTION_KEY)).toBe(
    cache,
  );
  expect((await readSession(f.token))!.userId).toBe(f.user.id);
  expect(await readSession(f.session.token)).toBeNull();
  expect(
    await db.sourceConnection.findUnique({
      where: { userId_provider: { userId: f.user.id, provider: "outlook" } },
    }),
  ).toMatchObject({
    authorizationId: null,
    microsoftAuthorizationId: auth!.id,
  });
});
it("wrong session and expired state fail before consuming legitimate callback", async () => {
  const f = await begin();
  const other = await createSession(f.user.id);
  await expect(
    f.h.service.completeAuthorization(
      { state: f.state, code: "synthetic" },
      other.token,
    ),
  ).rejects.toMatchObject({ code: "invalid_state" });
  expect(
    await db.oAuthState.count({ where: { sessionId: f.session.id } }),
  ).toBe(1);
  await db.oAuthState.updateMany({
    where: { sessionId: f.session.id },
    data: { expiresAt: new Date(0) },
  });
  await expect(
    f.h.service.completeAuthorization(
      { state: f.state, code: "synthetic" },
      f.session.token,
    ),
  ).rejects.toMatchObject({ code: "invalid_state" });
});
it.each([
  { error: "access_denied", want: "microsoft_consent_denied" },
  { error: "unauthorized_client", want: "microsoft_connection_blocked" },
  { want: "invalid_input" },
])(
  "denied/blocked/missing code consumes state with safe reason %#",
  async ({ error, want }) => {
    const f = await begin();
    await expect(
      f.h.service.completeAuthorization(
        { state: f.state, ...(error ? { error } : {}) },
        f.session.token,
      ),
    ).rejects.toMatchObject({ code: want });
    expect(
      await db.oAuthState.count({ where: { sessionId: f.session.id } }),
    ).toBe(0);
    await expect(
      f.h.service.completeAuthorization(
        { state: f.state, code: "replay" },
        f.session.token,
      ),
    ).rejects.toMatchObject({ code: "invalid_state" });
  },
);
it.each([
  "nonce",
  "tenant",
  "account",
  "audience",
  "issuer",
  "expired",
  "scope",
  "refresh",
])("rejects invalid callback identity/capability: %s", async (kind) => {
  const f = await begin();
  f.h.change((r) => ({
    ...r,
    ...(kind === "scope" ? { scopes: ["openid"] } : {}),
    ...(kind === "refresh" ? { refreshCapable: false } : {}),
    identity: {
      ...r.identity,
      ...(kind === "nonce" ? { nonce: "wrong" } : {}),
      ...(kind === "tenant"
        ? { tenantId: "44444444-4444-4444-8444-444444444444" }
        : {}),
      ...(kind === "account" ? { accountId: "not-an-object-id" } : {}),
      ...(kind === "audience" ? { audience: "wrong" } : {}),
      ...(kind === "issuer" ? { issuer: "https://example.test" } : {}),
      ...(kind === "expired" ? { expiresAt: 0 } : {}),
    },
  }));
  await expect(
    f.h.service.completeAuthorization(
      { state: f.state, code: "synthetic" },
      f.session.token,
    ),
  ).rejects.toBeInstanceOf(AppError);
  expect(
    (
      await db.microsoftAuthorization.findUnique({
        where: { userId: f.user.id },
      })
    )?.tokenCache,
  ).toBeNull();
});
it("exchange exceptions never surface raw token/content in callback body or logs", async () => {
  const f = await begin();
  f.h.fail(new Error("synthetic-refresh-only private provider response"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await request(
      createApp({ config, microsoftOAuth: f.h.service }),
    )
      .get("/auth/microsoft/callback")
      .query({ state: f.state, code: "synthetic" })
      .set("Cookie", "hub_session=" + f.session.token);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?microsoft=failed");
    expect(
      JSON.stringify(res.body) + JSON.stringify(log.mock.calls),
    ).not.toContain("synthetic-refresh-only");
  } finally {
    log.mockRestore();
  }
});
it.each([
  ["access_denied", "denied"],
  ["unauthorized_client", "blocked"],
])(
  "browser callback %s returns safe recovery without consuming another provider's state",
  async (providerError, outcome) => {
    const f = await begin();
    const app = createApp({ config, microsoftOAuth: f.h.service });
    const res = await request(app)
      .get("/auth/microsoft/callback")
      .query({
        state: f.state,
        error: providerError,
        error_description: "synthetic-private-diagnostic",
      })
      .set("Cookie", "hub_session=" + f.session.token);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?microsoft=" + outcome);
    expect(res.text + JSON.stringify(res.headers)).not.toContain(
      "synthetic-private-diagnostic",
    );
    expect(
      await db.oAuthState.count({
        where: { sessionId: f.session.id, intent: "microsoft" },
      }),
    ).toBe(0);
    expect(
      (
        await request(app)
          .get("/api/connections")
          .set("Cookie", "hub_session=" + f.session.token)
      ).status,
    ).toBe(200);
    const replay = await request(app)
      .get("/auth/microsoft/callback")
      .query({ state: f.state, error: providerError })
      .set("Cookie", "hub_session=" + f.session.token);
    expect(replay.headers.location).toBe("/?microsoft=failed");
  },
);
it("Microsoft routes require CSRF for linking and never return token cache", async () => {
  const f = await connected();
  const session = (await readSession(f.token))!;
  const app = createApp({ config, microsoftOAuth: f.h.service });
  expect(
    (
      await request(app)
        .post("/api/connections/microsoft/start")
        .set("Cookie", "hub_session=" + f.token)
    ).status,
  ).toBe(403);
  const status = await request(app)
    .get("/api/connections/microsoft")
    .set("Cookie", "hub_session=" + f.token);
  expect(status.body).toEqual({ configured: true, status: "connected" });
  expect(JSON.stringify(status.body)).not.toContain("token");
  const started = await request(app)
    .post("/api/connections/microsoft/start")
    .set("Cookie", "hub_session=" + f.token)
    .set("Origin", config.APP_ORIGIN)
    .set("x-csrf-token", session.csrf);
  expect(started.status).toBe(200);
  expect(started.body.url).toContain("login.microsoftonline.com");
});
it("silent access rotates encrypted cache independently of Gmail", async () => {
  const f = await connected();
  f.h.change((r) => ({
    ...r,
    cache: r.cache.replace("synthetic-refresh-only", "synthetic-rotated-only"),
  }));
  const access = await f.h.service.accessToken(f.actor);
  expect(access.accessToken).toBe("synthetic-access-only");
  const row = await db.microsoftAuthorization.findUnique({
    where: { userId: f.user.id },
  });
  expect(decryptToken(row!.tokenCache!, config.TOKEN_ENCRYPTION_KEY)).toContain(
    "synthetic-rotated-only",
  );
  expect(
    (await db.sourceConnection.findUnique({ where: { id: f.connection.id } }))!
      .status,
  ).toBe("connected");
});
it("temporary refresh failure preserves cache while revoked authorization clears only Microsoft", async () => {
  const f = await connected();
  f.h.fail(new AppError("microsoft_unavailable", 503));
  await expect(f.h.service.accessToken(f.actor)).rejects.toMatchObject({
    code: "microsoft_unavailable",
  });
  expect(
    (await db.microsoftAuthorization.findUnique({
      where: { userId: f.user.id },
    }))!.tokenCache,
  ).not.toBeNull();
  f.h.fail(new AppError("microsoft_reauthorization_required", 403));
  await expect(f.h.service.accessToken(f.actor)).rejects.toMatchObject({
    code: "microsoft_reauthorization_required",
  });
  expect(
    await db.microsoftAuthorization.findUnique({
      where: { userId: f.user.id },
    }),
  ).toMatchObject({ status: "reauthorization_required", tokenCache: null });
  expect(
    (await db.googleAuthorization.findUnique({ where: { userId: f.user.id } }))!
      .status,
  ).toBe("connected");
});
it("refresh identity mismatch cannot silently switch account", async () => {
  const f = await connected();
  f.h.change((r) => ({
    ...r,
    identity: {
      ...r.identity,
      accountId: "44444444-4444-4444-8444-444444444444",
    },
  }));
  await expect(f.h.service.accessToken(f.actor)).rejects.toMatchObject({
    code: "microsoft_reauthorization_required",
  });
});
it("Microsoft disconnect clears cache and pending states while preserving Gmail and imports", async () => {
  const f = await connected();
  await f.h.service.startAuthorization(f.token);
  await f.h.service.disconnect(f.actor);
  expect(
    await db.microsoftAuthorization.findUnique({
      where: { userId: f.user.id },
    }),
  ).toMatchObject({ status: "disconnected", tokenCache: null });
  expect(
    await db.oAuthState.count({
      where: { intent: "microsoft", session: { userId: f.user.id } },
    }),
  ).toBe(0);
  expect(
    (await db.sourceConnection.findUnique({ where: { id: f.connection.id } }))!
      .status,
  ).toBe("connected");
  await expect(f.h.service.accessToken(f.actor)).rejects.toMatchObject({
    code: "microsoft_reauthorization_required",
  });
});
it("disconnect racing refresh prevents stale cache resurrection", async () => {
  const f = await connected();
  let resume = () => {};
  f.h.pause(
    new Promise<void>((resolve) => {
      resume = resolve;
    }),
  );
  const access = f.h.service.accessToken(f.actor);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await f.h.service.disconnect(f.actor);
  resume();
  await expect(access).rejects.toMatchObject({
    code: "microsoft_reauthorization_required",
  });
  expect(
    (await db.microsoftAuthorization.findUnique({
      where: { userId: f.user.id },
    }))!.tokenCache,
  ).toBeNull();
});
it("disconnect racing the first callback prevents connection resurrection", async () => {
  const f = await begin();
  let resume = () => {};
  f.h.pause(
    new Promise<void>((resolve) => {
      resume = resolve;
    }),
  );
  const callback = f.h.service.completeAuthorization(
    { state: f.state, code: "synthetic" },
    f.session.token,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  await f.h.service.disconnect(f.actor);
  resume();
  await expect(callback).rejects.toMatchObject({ code: "invalid_state" });
  expect(
    (await db.microsoftAuthorization.findUnique({
      where: { userId: f.user.id },
    }))!.tokenCache,
  ).toBeNull();
});
it("a disconnected account can reconnect only to the same tenant/object identity", async () => {
  const f = await connected();
  await f.h.service.disconnect(f.actor);
  const state = new URL(
    (await f.h.service.startAuthorization(f.token)).url,
  ).searchParams.get("state")!;
  f.h.change((r) => ({
    ...r,
    identity: {
      ...r.identity,
      accountId: "44444444-4444-4444-8444-444444444444",
    },
  }));
  await expect(
    f.h.service.completeAuthorization({ state, code: "synthetic" }, f.token),
  ).rejects.toMatchObject({ code: "account_mismatch" });
});
it("disabled Microsoft support does not gate Google workspace routes", async () => {
  const f = await fixture();
  const session = await createSession(f.user.id);
  const {
    MICROSOFT_CLIENT_ID: _id,
    MICROSOFT_TENANT_ID: _tenant,
    MICROSOFT_CLIENT_SECRET: _secret,
    MICROSOFT_REDIRECT_URI: _uri,
    ...googleOnly
  } = config;
  const app = createApp({ config: googleOnly });
  const status = await request(app)
    .get("/api/connections/microsoft")
    .set("Cookie", "hub_session=" + session.token);
  expect(status.body).toEqual({ configured: false, status: "disconnected" });
  expect(
    (
      await request(app)
        .get("/api/connections")
        .set("Cookie", "hub_session=" + session.token)
    ).status,
  ).toBe(200);
});
