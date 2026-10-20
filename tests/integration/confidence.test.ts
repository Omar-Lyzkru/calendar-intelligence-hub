import { it, expect, afterAll } from "vitest";
import request from "supertest";
import { fixture } from "./helpers.js";
import { db, json } from "../../apps/api/src/infrastructure/persistence/db.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import {
  saveReview,
  approveReview,
} from "../../apps/api/src/application/approveReview.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import { deleteContent } from "../../apps/api/src/infrastructure/persistence/retention.js";
import { createSession } from "../../apps/api/src/infrastructure/sessions/store.js";
import { createApp } from "../../apps/api/src/app.js";
import { ReviewDetailSchema } from "@hub/contracts";
import { payloadHash } from "../../apps/api/src/infrastructure/google/calendar.js";
afterAll(() => db.$disconnect());
const temporal = {
  kind: "all_day" as const,
  startDate: "2026-10-20",
  endExclusive: "2026-10-21",
};
async function review(content = "Workshop next Friday") {
  const f = await fixture();
  const imported = await saveProcessedMessage(
    f.actor,
    { ...f.message, content },
    processMessage({ ...f.message, content }, "America/Chicago"),
  );
  return {
    ...f,
    id: imported.reviewId!,
    detail: await getReview(f.actor, imported.reviewId!),
  };
}
it("confidence survives correction and approval independently of validity and Calendar hash", async () => {
  const f = await review();
  expect(f.detail.candidate.confidence?.band).toBe("low");
  const original = f.detail.candidate.confidence;
  const saved = await saveReview(f.actor, f.id, 1, {
    ...f.detail.draft,
    title: "Corrected Workshop",
    temporal,
  });
  expect(saved.state?.actions.approve).toBe(true);
  expect(saved.candidate.confidence).toEqual(original);
  const approved = await approveReview(f.actor, f.id, saved.revision);
  expect(approved.candidate.confidence).toEqual(original);
  expect(approved.approvedSnapshot).not.toHaveProperty("confidence");
  expect(payloadHash(approved.approvedSnapshot!)).toBe(
    payloadHash({ ...approved.approvedSnapshot!, eventCategory: "career" }),
  );
  await deleteContent(f.user.id, f.message.id);
  const redacted = await getReview(f.actor, f.id);
  expect(redacted.candidate.confidence).toEqual(original);
  expect(redacted.candidate.evidence.every((e) => e.text === undefined)).toBe(
    true,
  );
  expect(redacted.approvedSnapshot).toEqual(approved.approvedSnapshot);
});
it("high extraction support never permits missing title API bypass", async () => {
  const f = await review(
    "Workshop October 20, 2026 at 10:00 AM to 11:00 AM Central Time",
  );
  expect(f.detail.candidate.confidence?.band).toBe("high");
  const saved = await saveReview(f.actor, f.id, 1, {
    ...f.detail.draft,
    title: "",
  });
  await expect(
    approveReview(f.actor, f.id, saved.revision),
  ).rejects.toMatchObject({ code: "incomplete_event" });
  expect(await db.calendarEvent.count({ where: { reviewItemId: f.id } })).toBe(
    0,
  );
});
it("legacy null confidence remains readable without a backfill", async () => {
  const f = await review();
  const r = await db.reviewItem.findUniqueOrThrow({ where: { id: f.id } });
  await db.detectedEvent.update({
    where: { id: r.detectedEventId },
    data: { candidate: json({ ...f.detail.candidate, confidence: null }) },
  });
  const legacy = await getReview(f.actor, f.id);
  expect(legacy.candidate.confidence).toBeNull();
  expect(ReviewDetailSchema.safeParse(legacy).success).toBe(true);
});
it("HTTP returns validated reports only to owner and does not expose credentials", async () => {
  const f = await review();
  const session = await createSession(f.user.id);
  const app = createApp({
    config: {
      NODE_ENV: "test",
      PORT: 43179,
      APP_ORIGIN: "http://localhost:5173",
      DATABASE_URL: process.env.DATABASE_URL!,
      GOOGLE_CLIENT_ID: "synthetic",
      GOOGLE_CLIENT_SECRET: "synthetic",
      GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
      TOKEN_ENCRYPTION_KEY: "1".repeat(64),
      PROVIDER_TIMEOUT_MS: 15000,
    },
  });
  const response = await request(app)
    .get("/api/reviews/" + f.id)
    .set("Cookie", "hub_session=" + session.token);
  expect(response.status).toBe(200);
  expect(
    ReviewDetailSchema.parse(response.body).candidate.confidence?.band,
  ).toBe("low");
  expect(response.text).not.toMatch(
    /refreshToken|clientSecret|TOKEN_ENCRYPTION/,
  );
  const other = await fixture();
  const foreign = await createSession(other.user.id);
  expect(
    (
      await request(app)
        .get("/api/reviews/" + f.id)
        .set("Cookie", "hub_session=" + foreign.token)
    ).status,
  ).toBe(404);
});
it("source projection exposes only provider, received date and content availability", async () => {
  const f = await review();
  const detail = await getReview(f.actor, f.id);
  expect(detail).toHaveProperty("source", {
    provider: "gmail",
    receivedAt: "2026-10-07T12:00:00.000Z",
    contentStatus: "available",
  });
  await deleteContent(f.user.id, f.message.id);
  expect(await getReview(f.actor, f.id)).toHaveProperty(
    "source.contentStatus",
    "expired_or_deleted",
  );
});
