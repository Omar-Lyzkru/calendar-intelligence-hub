import { it, expect, afterAll } from "vitest";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import {
  createSession,
  readSession,
  destroySession,
} from "../../apps/api/src/infrastructure/sessions/store.js";
import { OAuthService } from "../../apps/api/src/infrastructure/google/oauth.js";
import { fixture } from "./helpers.js";
const config = {
  NODE_ENV: "test" as const,
  PORT: 3000,
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: process.env.DATABASE_URL!,
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
  GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
  TOKEN_ENCRYPTION_KEY: "1".repeat(64),
  PROVIDER_TIMEOUT_MS: 15000,
};
function service(
  subject: string,
  scope = "openid email profile",
  nonceOverride?: string,
) {
  let nonce = "";
  const gateway = {
    authorizationUrl: (p: Record<string, string>) => {
      nonce = p.nonce;
      return "https://accounts.google.com/?state=" + p.state;
    },
    exchange: async () => ({ idToken: "fake", refreshToken: "refresh", scope }),
    verify: async () => ({
      sub: subject,
      email: "synthetic@example.test",
      nonce: nonceOverride ?? nonce,
    }),
  };
  return new OAuthService(config, gateway);
}
afterAll(() => db.$disconnect());
it("logout_invalidates_session", async () => {
  const s = await createSession();
  expect(await readSession(s.token)).not.toBeNull();
  await destroySession(s.token);
  expect(await readSession(s.token)).toBeNull();
});
it("expired_or_replayed_state_is_rejected_and_session_rotates", async () => {
  const s = await createSession();
  const svc = service(crypto.randomUUID());
  const p = await svc.startAuthorization("login", s.token);
  const state = new URL(p.url).searchParams.get("state")!;
  const result = await svc.completeAuthorization(
    { state, code: "code" },
    s.token,
  );
  expect(result.token).not.toBe(s.token);
  expect(await readSession(s.token)).toBeNull();
  await expect(
    svc.completeAuthorization({ state, code: "code" }, result.token),
  ).rejects.toThrow();
});
it("expired_state_is_rejected", async () => {
  const s = await createSession();
  const svc = service("sub");
  const p = await svc.startAuthorization("login", s.token);
  await db.oAuthState.updateMany({
    where: { sessionId: s.id },
    data: { expiresAt: new Date(0) },
  });
  await expect(
    svc.completeAuthorization(
      { state: new URL(p.url).searchParams.get("state")!, code: "x" },
      s.token,
    ),
  ).rejects.toThrow();
});
it("callback_wrong_account_is_rejected", async () => {
  const f = await fixture();
  const s = await createSession(f.user.id);
  const svc = service(
    "wrong",
    "openid email profile https://www.googleapis.com/auth/gmail.readonly",
  );
  const p = await svc.startAuthorization("gmail", s.token);
  await expect(
    svc.completeAuthorization(
      { state: new URL(p.url).searchParams.get("state")!, code: "x" },
      s.token,
    ),
  ).rejects.toMatchObject({ code: "account_mismatch" });
});
it("invalid_nonce_or_id_token_is_rejected", async () => {
  const s = await createSession();
  const svc = service("sub", "openid email profile", "bad-nonce");
  const p = await svc.startAuthorization("login", s.token);
  await expect(
    svc.completeAuthorization(
      { state: new URL(p.url).searchParams.get("state")!, code: "x" },
      s.token,
    ),
  ).rejects.toMatchObject({ code: "invalid_identity" });
});

import request from "supertest";
import { createApp } from "../../apps/api/src/app.js";
import { encryptToken } from "../../apps/api/src/infrastructure/google/tokenVault.js";
import { providerClient } from "../../apps/api/src/infrastructure/google/providerClient.js";
it("mutation_requires_origin_and_csrf", async () => {
  const app = createApp({ config });
  const me = await request(app).get("/api/me");
  const cookie = me.headers["set-cookie"][0].split(";")[0];
  expect(
    (await request(app).post("/api/logout").set("Cookie", cookie)).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post("/api/logout")
        .set("Cookie", cookie)
        .set("Origin", config.APP_ORIGIN)
        .set("x-csrf-token", me.body.csrf)
    ).status,
  ).toBe(204);
});
it("omitted_refresh_token_preserves_existing", async () => {
  const f = await fixture();
  const cipher = encryptToken("existing", config.TOKEN_ENCRYPTION_KEY);
  await db.googleAuthorization.update({
    where: { userId: f.user.id },
    data: { refreshToken: cipher },
  });
  const s = await createSession(f.user.id);
  let nonce = "";
  const svc = new OAuthService(config, {
    authorizationUrl: (p) => {
      nonce = p.nonce;
      return "https://accounts.google.com/?state=" + p.state;
    },
    exchange: async () => ({
      idToken: "fake",
      scope:
        "openid email profile https://www.googleapis.com/auth/gmail.readonly",
    }),
    verify: async () => ({
      sub: f.user.googleSubject,
      email: f.user.email,
      nonce,
    }),
  });
  const p = await svc.startAuthorization("gmail", s.token);
  await svc.completeAuthorization(
    { state: new URL(p.url).searchParams.get("state")!, code: "x" },
    s.token,
  );
  expect(
    (await db.googleAuthorization.findUnique({ where: { userId: f.user.id } }))
      ?.refreshToken,
  ).toBe(cipher);
});
it("revoked_refresh_requires_reauthorization", async () => {
  const f = await fixture();
  await db.googleAuthorization.update({
    where: { userId: f.user.id },
    data: {
      refreshToken: encryptToken("revoked", config.TOKEN_ENCRYPTION_KEY),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    },
  });
  await expect(
    providerClient(
      f.actor,
      "https://www.googleapis.com/auth/gmail.readonly",
      config,
      async () => {
        throw { response: { data: { error: "invalid_grant" } } };
      },
    ),
  ).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(
    (await db.googleAuthorization.findUnique({ where: { userId: f.user.id } }))
      ?.status,
  ).toBe("reauthorization_required");
});
