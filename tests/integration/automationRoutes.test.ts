import { it, expect, afterAll } from "vitest";
import request from "supertest";
import { setup, provider } from "./automationHelpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { createApp } from "../../apps/api/src/app.js";
import { createSession } from "../../apps/api/src/infrastructure/sessions/store.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import { saveReview } from "../../apps/api/src/application/approveReview.js";
import { evaluateReview } from "../../apps/api/src/application/automation/engine.js";
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
it("automation settings and question answers require session, origin and CSRF", async () => {
  const f = await setup(),
    p = provider(),
    s = await createSession(f.user.id);
  const app = createApp({ config, calendar: p.gateway });
  expect((await request(app).get("/api/automation/policy")).status).toBe(401);
  const policy = await request(app)
    .get("/api/automation/policy")
    .set("Cookie", "hub_session=" + s.token);
  expect(policy.status).toBe(200);
  expect(policy.body.liveWritesEnabled).toBe(false);
  expect(JSON.stringify(policy.body)).not.toContain("GOOGLE_CLIENT_SECRET");
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, { ...r.draft, title: "" });
  await evaluateReview(f.actor, f.id, p.gateway);
  const q = await db.automationQuestion.findFirstOrThrow({
    where: { userId: f.user.id, status: "open" },
  });
  const path = "/api/automation/questions/" + q.id + "/answer";
  expect(
    (
      await request(app)
        .post(path)
        .set("Cookie", "hub_session=" + s.token)
        .send({
          expectedRevision: q.reviewRevision,
          answer: { kind: "title", value: "Exam" },
        })
    ).status,
  ).toBe(403);
  const answer = await request(app)
    .post(path)
    .set("Cookie", "hub_session=" + s.token)
    .set("Origin", config.APP_ORIGIN)
    .set("x-csrf-token", s.csrf)
    .send({
      expectedRevision: q.reviewRevision,
      answer: { kind: "title", value: "Exam" },
    });
  expect(answer.status).toBe(200);
  expect(answer.body.reason).toBe("live_acceptance_required");
  expect(p.count()).toBe(0);
});
it("client cannot enable the operator write gate or submit private settings fields", async () => {
  const f = await setup(),
    p = provider(),
    s = await createSession(f.user.id);
  const app = createApp({ config, calendar: p.gateway });
  const changed = await request(app)
    .put("/api/automation/policy")
    .set("Cookie", "hub_session=" + s.token)
    .set("Origin", config.APP_ORIGIN)
    .set("x-csrf-token", s.csrf)
    .send({
      expectedRevision: 2,
      enabled: true,
      pollGmail: false,
      rules: [],
      allowWrites: true,
    });
  expect(changed.status).toBe(422);
  expect(p.count()).toBe(0);
});
