import { it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import { fixture } from "./helpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import * as processing from "../../apps/api/src/application/processMessage.js";
import {
  saveReview,
  approveReview,
  ignoreReview,
} from "../../apps/api/src/application/approveReview.js";
import { importMessages } from "../../apps/api/src/application/importMessages.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import { createSession } from "../../apps/api/src/infrastructure/sessions/store.js";
import { createApp } from "../../apps/api/src/app.js";
import { AppError } from "@hub/contracts";
afterAll(() => db.$disconnect());
async function review(subject = "Workshop") {
  const f = await fixture();
  const message = {
    ...f.message,
    subject,
    content: "Workshop October 20, 2026",
  };
  const r = await saveProcessedMessage(
    f.actor,
    message,
    processing.processMessage(message, "America/Chicago"),
  );
  return {
    ...f,
    id: r.reviewId!,
    detail: await getReview(f.actor, r.reviewId!),
  };
}
const readyTemporal = {
  kind: "all_day" as const,
  startDate: "2026-10-20",
  endExclusive: "2026-10-21",
};
it("empty-title candidate can save and ignore but approval returns simultaneous blockers", async () => {
  const f = await review("");
  expect(f.detail.draft.title).toBe("");
  const saved = await saveReview(f.actor, f.id, 1, f.detail.draft);
  expect(saved.state?.readiness.blockers.map((b) => b.code)).toEqual([
    "title_required",
    "date_only_unconfirmed",
  ]);
  await expect(
    approveReview(f.actor, f.id, saved.revision),
  ).rejects.toMatchObject({
    code: "incomplete_event",
    status: 422,
    details: {
      blockers: [{ code: "title_required" }, { code: "date_only_unconfirmed" }],
    },
  });
  expect(
    (await ignoreReview(f.actor, f.id, saved.revision)).state?.workflow.phase,
  ).toBe("ignored");
  expect(await db.calendarEvent.count({ where: { reviewItemId: f.id } })).toBe(
    0,
  );
});
it.each(["No subject", "Event needing review"])(
  "mutable legacy fallback %s is blocked without rewriting original evidence",
  async (title) => {
    const f = await review();
    await db.reviewItem.update({
      where: { id: f.id },
      data: { draft: { ...f.detail.draft, title, temporal: readyTemporal } },
    });
    const before = await db.detectedEvent.findUnique({
      where: {
        id: (await db.reviewItem.findUniqueOrThrow({ where: { id: f.id } }))
          .detectedEventId,
      },
    });
    expect(
      (await getReview(f.actor, f.id)).state?.readiness.blockers.map(
        (b) => b.code,
      ),
    ).toEqual(["title_required"]);
    await expect(approveReview(f.actor, f.id, 1)).rejects.toMatchObject({
      code: "incomplete_event",
    });
    const saved = await saveReview(f.actor, f.id, 1, {
      ...f.detail.draft,
      title: "Exam",
      temporal: readyTemporal,
    });
    expect(saved.state?.actions.approve).toBe(true);
    expect(
      (await approveReview(f.actor, f.id, 2)).approvedSnapshot?.title,
    ).toBe("Exam");
    expect(
      await db.detectedEvent.findUnique({ where: { id: before!.id } }),
    ).toEqual(before);
  },
);
it("immutable legacy fallback snapshot remains readable and ready under historical policy", async () => {
  const f = await review();
  const snapshot = {
    ...f.detail.draft,
    title: "Event needing review",
    temporal: readyTemporal,
  };
  await db.reviewItem.update({
    where: { id: f.id },
    data: { status: "approved", approvedSnapshot: snapshot, draft: snapshot },
  });
  const d = await getReview(f.actor, f.id);
  expect(d.approvedSnapshot).toEqual(snapshot);
  expect(d.state?.readiness.status).toBe("ready");
  expect(d.state?.actions.write).toBe(true);
});
it("optional details and corrected temporal facts remove blockers while extraction warnings remain original", async () => {
  const f = await review("");
  const saved = await saveReview(f.actor, f.id, 1, {
    ...f.detail.draft,
    title: "Exam",
    location: null,
    description: null,
    temporal: readyTemporal,
  });
  expect(saved.state?.readiness).toEqual({
    status: "ready",
    blockers: [],
    missingFields: [],
  });
  expect(saved.candidate.draft.temporal.kind).toBe("date_only");
  expect(
    (await approveReview(f.actor, f.id, saved.revision)).approvedSnapshot
      ?.location,
  ).toBe(null);
});
function payload(id: string) {
  return {
    id,
    internalDate: "1791374400000",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "Meeting" }],
      body: { data: Buffer.from("Meeting next Friday").toString("base64url") },
    },
  };
}
it("ambiguity is review, parser crash and invalid provider payload have safe distinct stages", async () => {
  const f = await fixture();
  const gmail = {
    list: async () => ({ messages: [] }),
    get: async (_a: unknown, id: string) =>
      id === "bad" ? { id } : payload(id),
  };
  expect(
    (await importMessages(f.actor, ["ambiguous"], gmail)).items[0],
  ).toMatchObject({
    status: "review",
    state: { readiness: { status: "blocked" } },
  });
  expect(
    (await importMessages(f.actor, ["bad"], gmail)).items[0],
  ).toMatchObject({
    status: "failed",
    processingFailure: { stage: "normalize", code: "invalid_provider_payload" },
  });
  const spy = vi
    .spyOn(processing, "processMessage")
    .mockImplementationOnce(() => {
      throw new Error("PRIVATE-SENTINEL");
    });
  try {
    const failed = await importMessages(f.actor, ["crash"], gmail);
    expect(failed.items[0]).toMatchObject({
      processingFailure: { stage: "process", code: "processing_failed" },
    });
    expect(JSON.stringify(failed)).not.toContain("PRIVATE-SENTINEL");
  } finally {
    spy.mockRestore();
  }
  expect(
    await db.normalizedMessage.count({
      where: { sourceConnectionId: f.connection.id, externalId: "crash" },
    }),
  ).toBe(0);
  expect(
    (await importMessages(f.actor, ["crash"], gmail)).items[0].status,
  ).toBe("review");
});
it("unknown AppError does not leak through import results or history and persisted stages are accurate", async () => {
  const f = await fixture();
  const result = await importMessages(f.actor, ["failure"], {
    list: async () => ({ messages: [] }),
    get: async () => {
      throw new AppError("PRIVATE-SENTINEL", 502);
    },
  });
  expect(result.items[0]).toMatchObject({
    reason: "fetch_failed",
    processingFailure: { stage: "fetch" },
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE-SENTINEL");
  const attempt = await db.processingAttempt.findFirstOrThrow({
    where: { sourceConnectionId: f.connection.id, externalId: "failure" },
  });
  expect(attempt.stage).toBe("fetch");
  expect(attempt.errorCode).toBe("fetch_failed");
  expect(
    JSON.stringify(
      await db.historyEntry.findMany({ where: { userId: f.actor.userId } }),
    ),
  ).not.toContain("PRIVATE-SENTINEL");
});
it("ignored reimport returns the same ignored workflow without another parser call", async () => {
  const f = await fixture();
  const gmail = {
    list: async () => ({ messages: [] }),
    get: async (_a: unknown, id: string) => payload(id),
  };
  const first = (await importMessages(f.actor, ["one"], gmail)).items[0];
  await ignoreReview(f.actor, first.reviewId!, 1);
  const spy = vi.spyOn(processing, "processMessage");
  try {
    const again = (await importMessages(f.actor, ["one"], gmail)).items[0];
    expect(again.reviewId).toBe(first.reviewId);
    expect(again.state?.workflow.phase).toBe("ignored");
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
it("storage failure cannot be reported as durable history or successful import", async () => {
  const f = await fixture();
  const spy = vi
    .spyOn(db, "$transaction")
    .mockRejectedValueOnce(new Error("PRIVATE-STORAGE-SENTINEL"));
  try {
    await expect(
      importMessages(f.actor, ["fail"], {
        list: async () => ({ messages: [] }),
        get: async () => {
          throw Error("PRIVATE-PROVIDER-SENTINEL");
        },
      }),
    ).rejects.toMatchObject({ code: "persistence_failed" });
  } finally {
    spy.mockRestore();
  }
});
it("HTTP approval blocker response is structured and invalid bypass makes no provider call", async () => {
  const f = await review("");
  const session = await createSession(f.user.id);
  const calendar = { get: vi.fn(async () => null), insert: vi.fn() };
  const app = createApp({
    config: {
      NODE_ENV: "test",
      PORT: 43175,
      APP_ORIGIN: "http://localhost:5173",
      DATABASE_URL: process.env.DATABASE_URL!,
      GOOGLE_CLIENT_ID: "synthetic",
      GOOGLE_CLIENT_SECRET: "synthetic",
      GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
      TOKEN_ENCRYPTION_KEY: "1".repeat(64),
      PROVIDER_TIMEOUT_MS: 15000,
    },
    calendar,
  });
  const r = await request(app)
    .post("/api/reviews/" + f.id + "/approve")
    .set("Cookie", "hub_session=" + session.token)
    .set("Origin", "http://localhost:5173")
    .set("x-csrf-token", session.csrf)
    .send({ expectedRevision: 1 });
  expect(r.status).toBe(422);
  expect(r.body.error.blockers.map((b: { code: string }) => b.code)).toEqual([
    "title_required",
    "date_only_unconfirmed",
  ]);
  expect(calendar.get).not.toHaveBeenCalled();
  expect(calendar.insert).not.toHaveBeenCalled();
});

it("active and expired leases produce distinct actions without changing the saved intent", async () => {
  const f = await review();
  await saveReview(f.actor, f.id, 1, {
    ...f.detail.draft,
    temporal: readyTemporal,
  });
  await approveReview(f.actor, f.id, 2);
  const { claimWrite } =
    await import("../../apps/api/src/infrastructure/persistence/calendarWrites.js");
  const claim = await claimWrite(f.actor, f.id);
  expect(claim.kind).toBe("claimed");
  expect((await getReview(f.actor, f.id)).state?.actions.write).toBe(false);
  await db.calendarEvent.update({
    where: { reviewItemId: f.id },
    data: { leaseUntil: new Date(0) },
  });
  expect((await getReview(f.actor, f.id)).state?.actions.write).toBe(true);
  if (claim.kind === "claimed")
    expect(
      (
        await db.calendarEvent.findUniqueOrThrow({
          where: { reviewItemId: f.id },
        })
      ).providerEventId,
    ).toBe(claim.intent.providerEventId);
});

it("an inconsistent added record cannot create a replacement write through a direct call", async () => {
  const f = await review();
  await db.reviewItem.update({
    where: { id: f.id },
    data: {
      status: "added",
      approvedSnapshot: { ...f.detail.draft, temporal: readyTemporal },
    },
  });
  const { createCalendarEvent } =
    await import("../../apps/api/src/application/createCalendarEvent.js");
  const gateway = { get: vi.fn(async () => null), insert: vi.fn() };
  await expect(
    createCalendarEvent(f.actor, f.id, gateway),
  ).rejects.toMatchObject({ code: "record_integrity_error" });
  expect(gateway.get).not.toHaveBeenCalled();
  expect(gateway.insert).not.toHaveBeenCalled();
});

it.each(["message_owner", "connection_owner"])(
  "cross-owner %s linkage is rejected without exposing content or mutating review",
  async (kind) => {
    const f = await review();
    const other = await fixture();
    const saved = await saveReview(f.actor, f.id, 1, {
      ...f.detail.draft,
      temporal: readyTemporal,
    });
    await db.normalizedMessage.update({
      where: { id: f.detail.messageId },
      data:
        kind === "message_owner"
          ? { userId: other.user.id }
          : { sourceConnectionId: other.connection.id },
    });
    await expect(getReview(f.actor, f.id)).rejects.toMatchObject({
      code: "record_integrity_error",
    });
    await expect(
      saveReview(f.actor, f.id, 2, saved.draft),
    ).rejects.toMatchObject({ code: "record_integrity_error" });
    await expect(ignoreReview(f.actor, f.id, 2)).rejects.toMatchObject({
      code: "record_integrity_error",
    });
    await expect(approveReview(f.actor, f.id, 2)).rejects.toMatchObject({
      code: "record_integrity_error",
    });
    expect(
      await db.reviewItem.findUniqueOrThrow({ where: { id: f.id } }),
    ).toMatchObject({
      status: "needs_review",
      revision: 2,
      approvedSnapshot: null,
    });
  },
);
it.each(["message_owner", "connection_owner"])(
  "cross-owner %s cannot create a Calendar intent from an existing approval",
  async (kind) => {
    const f = await review();
    const other = await fixture();
    await saveReview(f.actor, f.id, 1, {
      ...f.detail.draft,
      temporal: readyTemporal,
    });
    const approved = await approveReview(f.actor, f.id, 2);
    await db.normalizedMessage.update({
      where: { id: f.detail.messageId },
      data:
        kind === "message_owner"
          ? { userId: other.user.id }
          : { sourceConnectionId: other.connection.id },
    });
    const { createCalendarEvent } =
      await import("../../apps/api/src/application/createCalendarEvent.js");
    const gateway = { get: vi.fn(async () => null), insert: vi.fn() };
    await expect(
      createCalendarEvent(f.actor, f.id, gateway),
    ).rejects.toMatchObject({ code: "record_integrity_error" });
    expect(gateway.get).not.toHaveBeenCalled();
    expect(gateway.insert).not.toHaveBeenCalled();
    expect(
      await db.calendarEvent.count({ where: { reviewItemId: f.id } }),
    ).toBe(0);
    expect(
      (await db.reviewItem.findUniqueOrThrow({ where: { id: f.id } }))
        .approvedSnapshot,
    ).toEqual(approved.approvedSnapshot);
  },
);
it("contradictory mutable lifecycle cannot overwrite an immutable approval", async () => {
  const f = await review();
  const snapshot = { ...f.detail.draft, temporal: readyTemporal };
  await db.reviewItem.update({
    where: { id: f.id },
    data: { approvedSnapshot: snapshot, draft: snapshot },
  });
  expect((await getReview(f.actor, f.id)).state?.actions.approve).toBe(false);
  await expect(approveReview(f.actor, f.id, 1)).rejects.toMatchObject({
    code: "record_integrity_error",
  });
  await expect(
    saveReview(f.actor, f.id, 1, { ...snapshot, title: "Changed" }),
  ).rejects.toMatchObject({ code: "record_integrity_error" });
  expect(
    (await db.reviewItem.findUniqueOrThrow({ where: { id: f.id } }))
      .approvedSnapshot,
  ).toEqual(snapshot);
});
it("review list transports its separate pending and failed write outcomes", async () => {
  const f = await review();
  await saveReview(f.actor, f.id, 1, {
    ...f.detail.draft,
    temporal: readyTemporal,
  });
  await approveReview(f.actor, f.id, 2);
  const session = await createSession(f.user.id);
  const app = createApp({
    config: {
      NODE_ENV: "test",
      PORT: 43175,
      APP_ORIGIN: "http://localhost:5173",
      DATABASE_URL: process.env.DATABASE_URL!,
      GOOGLE_CLIENT_ID: "synthetic",
      GOOGLE_CLIENT_SECRET: "synthetic",
      GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
      TOKEN_ENCRYPTION_KEY: "1".repeat(64),
      PROVIDER_TIMEOUT_MS: 15000,
    },
  });
  const list = () =>
    request(app)
      .get("/api/reviews")
      .set("Cookie", "hub_session=" + session.token);
  const pending = await list();
  expect(pending.status).toBe(200);
  expect(pending.body.items[0].write).toBe(null);
  const { claimWrite, finishWrite } =
    await import("../../apps/api/src/infrastructure/persistence/calendarWrites.js");
  const claim = await claimWrite(f.actor, f.id);
  expect(claim.kind).toBe("claimed");
  if (claim.kind === "claimed")
    await finishWrite(f.actor, f.id, claim.intent.id, claim.intent.claimToken, {
      status: "failed",
      reason: "provider_rate_limited",
    });
  const failed = await list();
  expect(failed.status).toBe(200);
  expect(failed.body.items[0]).toMatchObject({
    status: "approved",
    write: { status: "failed", reason: "provider_rate_limited" },
  });
  expect(failed.body.items[0].state.workflow.phase).toBe("approved");
});
