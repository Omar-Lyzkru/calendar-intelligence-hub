import { it, expect, afterAll } from "vitest";
import request from "supertest";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { OAuthService } from "../../apps/api/src/infrastructure/google/oauth.js";
import { createSession } from "../../apps/api/src/infrastructure/sessions/store.js";
import { createApp } from "../../apps/api/src/app.js";
import { fixture } from "./helpers.js";
import { Client } from "pg";
import { readFileSync } from "node:fs";
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
};
afterAll(() => db.$disconnect());
it("SQL upgrade preserves pre-existing Gmail source content and approval history", async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // Roll back this synthetic schema, including its fixtures, after checking the upgrade.
  await client.query("BEGIN");
  try {
    const schema = "upgrade_" + crypto.randomUUID().replaceAll("-", "");
    await client.query('CREATE SCHEMA "' + schema + '"');
    await client.query('SET LOCAL search_path TO "' + schema + '"');
    await client.query(
      readFileSync(
        "prisma/migrations/20261007203421_initial/migration.sql",
        "utf8",
      ),
    );
    const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
    await client.query(
      'INSERT INTO "User" (id,"googleSubject",email) VALUES ($1,$2,$3)',
      [ids[0], "synthetic-legacy", "legacy@example.test"],
    );
    await client.query(
      'INSERT INTO "GoogleAuthorization" (id,"userId",subject,"refreshToken",scopes) VALUES ($1,$2,$3,$4,$5)',
      [
        ids[1],
        ids[0],
        "synthetic-legacy",
        "synthetic-encrypted-credential",
        ["gmail.readonly"],
      ],
    );
    await client.query(
      'INSERT INTO "SourceConnection" (id,"userId","authorizationId","externalAccountId") VALUES ($1,$2,$3,$4)',
      [ids[2], ids[0], ids[1], "synthetic-legacy"],
    );
    await client.query(
      'INSERT INTO "NormalizedMessage" (id,"userId","sourceConnectionId","externalId",source,content,"receivedAt","ingestedAt","expiresAt",metadata,"normalizationVersion",status) VALUES ($1,$2,$3,$4,$5,$6,now(),now(),now()+interval \'30 days\',$7,1,$8)',
      [
        ids[3],
        ids[0],
        ids[2],
        "legacy-message",
        "gmail",
        "Synthetic legacy source",
        {},
        "review",
      ],
    );
    await client.query(
      'INSERT INTO "DetectedEvent" (id,"messageId",candidate) VALUES ($1,$2,$3)',
      [ids[4], ids[3], { synthetic: "candidate" }],
    );
    await client.query(
      'INSERT INTO "ReviewItem" (id,"userId","detectedEventId",draft,status,"approvedSnapshot","approvedAt") VALUES ($1,$2,$3,$4,$5,$6,now())',
      [
        ids[5],
        ids[0],
        ids[4],
        { synthetic: "draft" },
        "approved",
        { synthetic: "immutable approval" },
      ],
    );
    const before = await client.query(
      'SELECT content,"approvedSnapshot",candidate,"refreshToken" FROM "NormalizedMessage", "ReviewItem", "DetectedEvent", "GoogleAuthorization"',
    );
    await client.query(
      readFileSync(
        "prisma/migrations/20261012185000_outlook_authorization/migration.sql",
        "utf8",
      ),
    );
    const after = await client.query(
      'SELECT content,"approvedSnapshot",candidate,"refreshToken" FROM "NormalizedMessage", "ReviewItem", "DetectedEvent", "GoogleAuthorization"',
    );
    expect(after.rows).toEqual(before.rows);
    expect(
      (
        await client.query(
          'SELECT provider,"authorizationId","microsoftAuthorizationId" FROM "SourceConnection"',
        )
      ).rows,
    ).toEqual([
      {
        provider: "gmail",
        authorizationId: ids[1],
        microsoftAuthorizationId: null,
      },
    ]);
    expect(
      (await client.query('SELECT count(*) FROM "MicrosoftAuthorization"'))
        .rows[0].count,
    ).toBe("0");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
async function outlook() {
  const f = await fixture();
  const auth = await db.microsoftAuthorization.create({
    data: {
      userId: f.user.id,
      tenantId: "22222222-2222-4222-8222-222222222222",
      accountId: "33333333-3333-4333-8333-333333333333",
      scopes: ["Mail.Read"],
    },
  });
  const source = await db.sourceConnection.create({
    data: {
      userId: f.user.id,
      provider: "outlook",
      microsoftAuthorizationId: auth.id,
      externalAccountId: auth.tenantId + ":" + auth.accountId,
    },
  });
  return { ...f, auth, source };
}
it("additive Microsoft schema preserves legacy Gmail-only connections", async () => {
  const f = await outlook();
  expect(
    await db.sourceConnection.findUnique({ where: { id: f.connection.id } }),
  ).toMatchObject({
    provider: "gmail",
    authorizationId: f.connection.authorizationId,
  });
  expect(f.source.authorizationId).toBeNull();
  expect(f.source.microsoftAuthorizationId).toBe(f.auth.id);
});
it("database rejects mixed or missing provider authorizations", async () => {
  const f = await outlook();
  await expect(
    db.sourceConnection.update({
      where: { id: f.source.id },
      data: { authorizationId: f.connection.authorizationId },
    }),
  ).rejects.toThrow();
  await expect(
    db.sourceConnection.update({
      where: { id: f.source.id },
      data: { microsoftAuthorizationId: null },
    }),
  ).rejects.toThrow();
  await expect(
    db.sourceConnection.update({
      where: { id: f.connection.id },
      data: { provider: "outlook" },
    }),
  ).rejects.toThrow();
});
it("Google disconnect does not disable Outlook or erase imported history", async () => {
  const f = await outlook();
  const session = await createSession(f.user.id);
  const res = await request(createApp({ config }))
    .delete("/api/connections/google")
    .set("Cookie", "hub_session=" + session.token)
    .set("Origin", config.APP_ORIGIN)
    .set("x-csrf-token", session.csrf);
  expect(res.status).toBe(200);
  expect(
    await db.sourceConnection.findUnique({ where: { id: f.source.id } }),
  ).toMatchObject({ status: "connected" });
  expect(
    await db.microsoftAuthorization.findUnique({ where: { id: f.auth.id } }),
  ).toMatchObject({ status: "connected" });
});
it("Google callback cannot consume Microsoft authorization state", async () => {
  const f = await fixture();
  const session = await createSession(f.user.id);
  let nonce = "";
  const oauth = new OAuthService(config, {
    authorizationUrl: (p) => {
      nonce = p.nonce;
      return "https://accounts.google.com/?state=" + p.state;
    },
    exchange: async () => ({
      idToken: "synthetic",
      scope: "openid email profile",
    }),
    verify: async () => ({
      sub: f.user.googleSubject,
      email: f.user.email,
      nonce,
    }),
  });
  const started = await oauth.startAuthorization("login", session.token);
  await db.oAuthState.updateMany({
    where: { sessionId: session.id },
    data: { intent: "microsoft" },
  });
  await expect(
    oauth.completeAuthorization(
      {
        state: new URL(started.url).searchParams.get("state")!,
        code: "synthetic-code",
      },
      session.token,
    ),
  ).rejects.toMatchObject({ code: "invalid_state" });
  expect(await db.oAuthState.count({ where: { sessionId: session.id } })).toBe(
    1,
  );
});
