import { it, expect, afterAll } from "vitest";
import request from "supertest";
import { fixture } from "./helpers.js";
import { createSession } from "../../apps/api/src/infrastructure/sessions/store.js";
import { createApp } from "../../apps/api/src/app.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
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
  DISCORD_BOT_TOKEN: "synthetic-token-not-real",
  DISCORD_GUILD_ID: String(900000000000000000n + BigInt(Date.now())),
  DISCORD_CHANNEL_IDS: "800000000000000002",
};
const runtime = {
  status: () => ({ state: "connected" as const, coverage: "capped" as const }),
  reconnect: async () => {},
  stop: async () => {
    stops++;
  },
};
let stops = 0;
afterAll(() => db.$disconnect());
it("Discord connection is owned, CSRF guarded and rejects client supplied source configuration", async () => {
  const f = await fixture(),
    session = await createSession(f.user.id);
  const app = createApp({
    config,
    discord: runtime,
    discordRest: { checkAccess: async () => {} },
  });
  expect((await request(app).get("/api/connections/discord")).status).toBe(401);
  expect(
    (
      await request(app)
        .post("/api/connections/discord")
        .set("Cookie", "hub_session=" + session.token)
        .send({})
    ).status,
  ).toBe(403);
  const connect = () =>
    request(app)
      .post("/api/connections/discord")
      .set("Cookie", "hub_session=" + session.token)
      .set("Origin", config.APP_ORIGIN)
      .set("x-csrf-token", session.csrf);
  expect((await connect().send({ guildId: "arbitrary" })).status).toBe(422);
  const accepted = await connect().send({});
  expect(accepted.status).toBe(200);
  expect(accepted.body).toMatchObject({
    configured: true,
    status: "connected",
    runtime: { state: "connected", coverage: "capped" },
  });
  expect(JSON.stringify(accepted.body)).not.toContain(config.DISCORD_GUILD_ID);
  expect(
    (
      await request(app)
        .get("/api/discord/messages")
        .set("Cookie", "hub_session=" + session.token)
    ).body.items,
  ).toEqual([]);
  const foreign = await fixture(),
    s2 = await createSession(foreign.user.id);
  await request(app)
    .delete("/api/connections/discord")
    .set("Cookie", "hub_session=" + s2.token)
    .set("Origin", config.APP_ORIGIN)
    .set("x-csrf-token", s2.csrf);
  expect(stops).toBe(0);
  expect(
    (
      await request(app)
        .post("/api/imports")
        .set("Cookie", "hub_session=" + session.token)
        .set("Origin", config.APP_ORIGIN)
        .set("x-csrf-token", session.csrf)
        .send({ provider: "discord", externalIds: ["800000000000000003"] })
    ).status,
  ).toBe(422);
});
it("missing Discord setup leaves existing Google workspace endpoints available", async () => {
  const f = await fixture(),
    s = await createSession(f.user.id);
  const app = createApp({
    config: {
      ...config,
      DISCORD_BOT_TOKEN: undefined,
      DISCORD_GUILD_ID: undefined,
      DISCORD_CHANNEL_IDS: undefined,
    },
  });
  const cookie = "hub_session=" + s.token;
  expect(
    (await request(app).get("/api/connections/discord").set("Cookie", cookie))
      .body.configured,
  ).toBe(false);
  expect(
    (await request(app).get("/api/reviews").set("Cookie", cookie)).status,
  ).toBe(200);
});
