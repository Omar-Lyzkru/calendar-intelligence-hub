import { it, expect, afterAll, vi } from "vitest";
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
import {
  deleteContent,
  purgeExpiredContent,
} from "../../apps/api/src/infrastructure/persistence/retention.js";
import { createSession } from "../../apps/api/src/infrastructure/sessions/store.js";
import { createApp } from "../../apps/api/src/app.js";
import { createCalendarEvent } from "../../apps/api/src/application/createCalendarEvent.js";
import { payloadHash } from "../../apps/api/src/infrastructure/google/calendar.js";
import type { ReadyEvent } from "@hub/contracts";
afterAll(() => db.$disconnect());
const temporal = {
  kind: "all_day" as const,
  startDate: "2026-10-20",
  endExclusive: "2026-10-21",
};
async function review() {
  const f = await fixture();
  const imported = await saveProcessedMessage(
    f.actor,
    f.message,
    processMessage(f.message, "America/Chicago"),
  );
  return {
    ...f,
    id: imported.reviewId!,
    detail: await getReview(f.actor, imported.reviewId!),
  };
}
const config = {
  NODE_ENV: "test" as const,
  PORT: 43175,
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: process.env.DATABASE_URL!,
  GOOGLE_CLIENT_ID: "synthetic",
  GOOGLE_CLIENT_SECRET: "synthetic",
  GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
  TOKEN_ENCRYPTION_KEY: "1".repeat(64),
  PROVIDER_TIMEOUT_MS: 15000,
};
it("queue projects the current category and rejects unsupported API edits safely", async () => {
  const f = await review();
  const session = await createSession(f.user.id);
  const app = createApp({ config });
  const list = () =>
    request(app)
      .get("/api/reviews")
      .set("Cookie", "hub_session=" + session.token);
  expect((await list()).body.items[0].eventCategory).toBe("hackathon_workshop");
  const invalid = await request(app)
    .patch("/api/reviews/" + f.id)
    .set("Cookie", "hub_session=" + session.token)
    .set("Origin", config.APP_ORIGIN)
    .set("x-csrf-token", session.csrf)
    .send({
      expectedRevision: 1,
      draft: { ...f.detail.draft, eventCategory: "arbitrary" },
    });
  expect(invalid.status).toBe(422);
  expect((await getReview(f.actor, f.id)).revision).toBe(1);
  await saveReview(f.actor, f.id, 1, {
    ...f.detail.draft,
    eventCategory: "career",
  });
  expect((await list()).body.items[0].eventCategory).toBe("career");
});
it("review correction freezes independently from extraction, reimport preserves identity and replay makes one write", async () => {
  const f = await review();
  const original = f.detail.candidate;
  const saved = await saveReview(f.actor, f.id, 1, {
    ...f.detail.draft,
    eventCategory: "career",
    temporal,
  });
  const approved = await approveReview(f.actor, f.id, saved.revision);
  expect(approved.approvedSnapshot?.eventCategory).toBe("career");
  expect(approved.candidate).toEqual(original);
  await expect(
    saveReview(f.actor, f.id, approved.revision, {
      ...approved.draft,
      eventCategory: "meeting",
    }),
  ).rejects.toMatchObject({ status: 409 });
  const again = await saveProcessedMessage(
    f.actor,
    f.message,
    processMessage({ ...f.message, content: "Exam" }, "America/Chicago"),
  );
  expect(again.reviewId).toBe(f.id);
  expect((await getReview(f.actor, f.id)).approvedSnapshot).toEqual(
    approved.approvedSnapshot,
  );
  const insert = vi.fn(
    async (_a: unknown, id: string, _e: ReadyEvent, hash: string) => ({
      providerEventId: id,
      calendarId: "primary",
      htmlLink: "https://calendar.google.com/calendar/u/0/r",
      payloadHash: hash,
    }),
  );
  const gateway = { get: vi.fn(async () => null), insert };
  const first = await createCalendarEvent(f.actor, f.id, gateway);
  expect(await createCalendarEvent(f.actor, f.id, gateway)).toEqual(first);
  expect(insert).toHaveBeenCalledTimes(1);
  const { eventCategory: _removed, ...legacy } = approved.approvedSnapshot!;
  expect(first.receipt?.payloadHash).toBe(payloadHash(legacy as ReadyEvent));
});
it("category changes preserve revision and owner guards", async () => {
  const f = await review(),
    other = await fixture();
  await expect(
    saveReview(other.actor, f.id, 1, {
      ...f.detail.draft,
      eventCategory: "social",
    }),
  ).rejects.toMatchObject({ status: 404 });
  await saveReview(f.actor, f.id, 1, {
    ...f.detail.draft,
    eventCategory: "social",
  });
  await expect(
    saveReview(f.actor, f.id, 1, {
      ...f.detail.draft,
      eventCategory: "career",
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await getReview(f.actor, f.id)).draft.eventCategory).toBe("social");
});
it("legacy missing category remains absent through read, edit, approval and queue", async () => {
  const f = await review();
  const { eventCategory: _removed, ...draft } = f.detail.draft;
  const { classification: _ignored, ...candidate } = f.detail.candidate;
  const row = await db.reviewItem.findUniqueOrThrow({ where: { id: f.id } });
  await db.reviewItem.update({
    where: { id: f.id },
    data: { draft: { ...draft, temporal } },
  });
  await db.detectedEvent.update({
    where: { id: row.detectedEventId },
    data: { candidate: json({ ...candidate, draft }) },
  });
  const old = await getReview(f.actor, f.id);
  expect(old.draft).not.toHaveProperty("eventCategory");
  expect(old.candidate).not.toHaveProperty("classification");
  const saved = await saveReview(f.actor, f.id, 1, old.draft);
  const approved = await approveReview(f.actor, f.id, saved.revision);
  expect(approved.approvedSnapshot).not.toHaveProperty("eventCategory");
  expect(approved.candidate).toEqual(old.candidate);
  const session = await createSession(f.user.id);
  const listed = await request(createApp({ config }))
    .get("/api/reviews")
    .set("Cookie", "hub_session=" + session.token);
  expect(listed.body.items[0]).not.toHaveProperty("eventCategory");
});
it.each(["delete", "expire"])(
  "%s strips category evidence text/spans while preserving code-only classification and reviewed facts",
  async (mode) => {
    const f = await review();
    await saveReview(f.actor, f.id, 1, {
      ...f.detail.draft,
      eventCategory: "social",
      temporal,
    });
    const approved = await approveReview(f.actor, f.id, 2);
    expect(
      f.detail.candidate.evidence.some(
        (e) => e.code.startsWith("category_keyword_") && e.text,
      ),
    ).toBe(true);
    if (mode === "delete") await deleteContent(f.user.id, f.message.id);
    else {
      await db.normalizedMessage.update({
        where: { id: f.message.id },
        data: { expiresAt: new Date(0) },
      });
      await purgeExpiredContent(new Date());
    }
    const after = await getReview(f.actor, f.id);
    expect(after.originalText).toBeNull();
    expect(after.candidate.classification).toEqual(
      f.detail.candidate.classification,
    );
    expect(
      after.candidate.evidence.every((e) => Object.keys(e).join() === "code"),
    ).toBe(true);
    expect(after.approvedSnapshot).toEqual(approved.approvedSnapshot);
    const raw = await db.detectedEvent.findFirstOrThrow({
      where: { messageId: f.message.id },
    });
    expect(
      (raw.candidate as any).evidence.every(
        (e: any) => Object.keys(e).join() === "code",
      ),
    ).toBe(true);
  },
);
