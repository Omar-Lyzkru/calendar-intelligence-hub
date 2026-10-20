import { it, expect, afterAll } from "vitest";
import request from "supertest";
import { AppError, type MessageSourceAdapter } from "@hub/contracts";
import { fixture } from "./helpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { importMessages } from "../../apps/api/src/application/importMessages.js";
import { normalizeOutlook } from "../../apps/api/src/infrastructure/microsoft/normalize.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import { deleteContent } from "../../apps/api/src/infrastructure/persistence/retention.js";
import { checkDuplicates } from "../../apps/api/src/application/checkDuplicates.js";
import { createApp } from "../../apps/api/src/app.js";
import { createSession } from "../../apps/api/src/infrastructure/sessions/store.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import type { CalendarGateway } from "../../apps/api/src/infrastructure/google/calendar.js";
const text = "Workshop October 20, 2026 at 2:00 PM to 3:00 PM Central Time";
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
const mail: MessageSourceAdapter = {
  provider: "outlook",
  list: async () => ({
    messages: [
      {
        id: "selected",
        subject: "Synthetic Workshop",
        sender: "",
        snippet: "",
      },
    ],
  }),
  get: async (_actor, id) => ({
    id,
    subject: "Synthetic Workshop",
    receivedDateTime: "2026-10-12T12:00:00Z",
    body: { contentType: "html", content: "<p>" + text + "</p>" },
    privateExtra: "not stored",
  }),
  normalize: normalizeOutlook,
};
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
      externalAccountId: "synthetic-account",
    },
  });
  return { ...f, source, auth };
}
afterAll(() => db.$disconnect());
it("throttling stops new fetches in a selected batch while preserving prior and completed imports", async () => {
  const f = await outlook();
  const previous = await importMessages(f.actor, ["previous"], mail);
  const fetched: string[] = [];
  const limited = new AppError("microsoft_rate_limited", 429);
  limited.retryAfterSeconds = 120;
  const batch = await importMessages(
    f.actor,
    ["completed", "limited", "previous", "deferred-one", "deferred-two"],
    {
      ...mail,
      get: async (actor, id) => {
        fetched.push(id);
        if (id === "limited") throw limited;
        return mail.get(actor, id);
      },
    },
  );
  expect(fetched).toEqual(["completed", "limited"]);
  expect(batch.items[0].status).toBe("review");
  expect(batch.items[2].reviewId).toBe(previous.items[0].reviewId);
  for (const index of [1, 3, 4])
    expect(batch.items[index]).toMatchObject({
      status: "failed",
      processingFailure: {
        code: "microsoft_rate_limited",
        retryAfterSeconds: 120,
        recovery: { action: "retry_import", canRetryNow: false },
      },
    });
  expect(
    await db.normalizedMessage.count({
      where: { sourceConnectionId: f.source.id },
    }),
  ).toBe(2);
});
it("selected import preserves a bounded retry delay with non-immediate recovery", async () => {
  const f = await outlook();
  const limited = new AppError("microsoft_rate_limited", 429);
  limited.retryAfterSeconds = 120;
  const batch = await importMessages(f.actor, ["selected"], {
    ...mail,
    get: async () => {
      throw limited;
    },
  });
  expect(batch.items[0].processingFailure).toMatchObject({
    code: "microsoft_rate_limited",
    retryAfterSeconds: 120,
    recovery: { action: "retry_import", canRetryNow: false },
  });
});
it("message-list rate limiting returns sanitized Retry-After without raw provider fields", async () => {
  const f = await outlook();
  const session = await createSession(f.user.id);
  const limited = new AppError("microsoft_rate_limited", 429);
  limited.retryAfterSeconds = 120;
  const app = createApp({
    config,
    outlook: {
      ...mail,
      list: async () => {
        throw limited;
      },
    },
  });
  const response = await request(app)
    .get("/api/outlook/messages")
    .set("Cookie", "hub_session=" + session.token);
  expect(response.status).toBe(429);
  expect(response.headers["retry-after"]).toBe("120");
  expect(response.body.error.code).toBe("microsoft_rate_limited");
});
it("Outlook HTML import reuses temporal readiness, category, confidence and original review projection", async () => {
  const f = await outlook();
  const batch = await importMessages(f.actor, ["selected"], mail);
  expect(batch.items[0].status).toBe("review");
  const detail = await getReview(f.actor, batch.items[0].reviewId!);
  expect(detail.source?.provider).toBe("outlook");
  expect(detail.originalText).toBe(text);
  expect(detail.candidate.confidence?.band).toBe("high");
  expect(detail.candidate.classification?.category).toBe("hackathon_workshop");
  expect(detail.state?.readiness.status).toBe("ready");
  expect(detail.draft.temporal).toMatchObject({
    kind: "timed",
    start: "2026-10-20T19:00:00.000Z",
    end: "2026-10-20T20:00:00.000Z",
    timezone: "America/Chicago",
  });
  const row = await db.normalizedMessage.findUniqueOrThrow({
    where: { id: detail.messageId },
  });
  expect(row.metadata).toEqual({});
  expect(JSON.stringify(row)).not.toContain("privateExtra");
});
it("repeat Outlook import is stable and source identity is independent of Gmail IDs", async () => {
  const f = await outlook();
  const first = await importMessages(f.actor, ["selected", "selected"], mail);
  expect(first.items).toHaveLength(1);
  expect(
    (await importMessages(f.actor, ["selected"], mail)).items[0].reviewId,
  ).toBe(first.items[0].reviewId);
  const same = {
    ...f.message,
    externalId: "selected",
    ingestedAt: new Date().toISOString(),
  };
  await saveProcessedMessage(
    f.actor,
    same,
    processMessage(same, f.user.timezone),
  );
  expect(
    await db.normalizedMessage.count({
      where: { userId: f.user.id, externalId: "selected" },
    }),
  ).toBe(2);
  expect(
    await db.processingAttempt.count({
      where: { sourceConnectionId: f.source.id, outcome: "review" },
    }),
  ).toBe(1);
});
it("Outlook can import with Gmail disconnected and its own failures do not corrupt reviews", async () => {
  const f = await outlook();
  await db.sourceConnection.update({
    where: { id: f.connection.id },
    data: { status: "disconnected" },
  });
  const first = await importMessages(f.actor, ["selected"], mail);
  expect(first.items[0].status).toBe("review");
  const failure = await importMessages(f.actor, ["unavailable"], {
    ...mail,
    get: async () => {
      throw new AppError("microsoft_unavailable", 503);
    },
  });
  expect(failure.items[0]).toMatchObject({
    status: "failed",
    processingFailure: {
      code: "microsoft_unavailable",
      recovery: { action: "retry_import" },
    },
  });
  expect(await db.reviewItem.count({ where: { userId: f.user.id } })).toBe(1);
  expect(
    await db.normalizedMessage.count({
      where: { sourceConnectionId: f.source.id },
    }),
  ).toBe(1);
});
it("Outlook malformed/missing body is normalization failure rather than no-event", async () => {
  const f = await outlook();
  const batch = await importMessages(f.actor, ["missing"], {
    ...mail,
    get: async () => ({
      id: "missing",
      receivedDateTime: "2026-10-12T12:00:00Z",
    }),
  });
  expect(batch.items[0]).toMatchObject({
    status: "failed",
    processingFailure: { stage: "normalize", code: "invalid_provider_payload" },
  });
  expect(
    await db.normalizedMessage.count({
      where: { sourceConnectionId: f.source.id },
    }),
  ).toBe(0);
});
it("provider ID/source mismatches cannot persist under the wrong source identity", async () => {
  const f = await outlook();
  const wrongId = await importMessages(f.actor, ["selected"], {
    ...mail,
    get: async () => ({
      ...((await mail.get(f.actor, "different")) as object),
    }),
  });
  expect(wrongId.items[0]).toMatchObject({
    status: "failed",
    reason: "provider_id_mismatch",
  });
  const wrongSource = await importMessages(f.actor, ["selected"], {
    ...mail,
    normalize: (p, c) => ({ ...normalizeOutlook(p, c), source: "gmail" }),
  });
  expect(wrongSource.items[0]).toMatchObject({ status: "failed" });
  expect(
    await db.normalizedMessage.count({
      where: { sourceConnectionId: f.source.id },
    }),
  ).toBe(0);
});
it("Outlook source deletion uses the existing provider-independent retention/redaction path", async () => {
  const f = await outlook();
  const batch = await importMessages(f.actor, ["selected"], mail);
  const detail = await getReview(f.actor, batch.items[0].reviewId!);
  await deleteContent(f.user.id, detail.messageId);
  const erased = await getReview(f.actor, detail.id);
  expect(erased.originalText).toBeNull();
  expect(erased.source).toMatchObject({
    provider: "outlook",
    contentStatus: "expired_or_deleted",
  });
  expect(erased.candidate.evidence.every((e) => e.text === undefined)).toBe(
    true,
  );
});
it("Outlook candidates reuse local/Google duplicate and different-commitment conflict advisories", async () => {
  const f = await outlook();
  const batch = await importMessages(f.actor, ["selected"], mail);
  const detail = await getReview(f.actor, batch.items[0].reviewId!);
  const local = {
    ...f.message,
    subject: "Synthetic Workshop",
    content: text,
    ingestedAt: new Date().toISOString(),
  };
  await saveProcessedMessage(
    f.actor,
    local,
    processMessage(local, f.user.timezone),
  );
  const temporal = {
    kind: "timed" as const,
    start: "2026-10-20T19:00:00.000Z",
    end: "2026-10-20T20:00:00.000Z",
    timezone: "America/Chicago",
  };
  const calendar: CalendarGateway = {
    get: async () => null,
    insert: async () => {
      throw Error("not allowed in advisory test");
    },
    list: async () => ({
      coverage: { status: "checked" },
      events: [
        {
          key: "google:duplicate",
          source: "google",
          title: "Synthetic Workshop",
          location: null,
          temporal,
          availability: "busy",
        },
        {
          key: "google:conflict",
          source: "google",
          title: "Different commitment",
          location: null,
          temporal,
          availability: "busy",
        },
      ],
    }),
  };
  const result = await checkDuplicates(
    f.actor,
    detail.id,
    detail.revision,
    calendar,
  );
  expect(result.google.status).toBe("checked");
  expect(result.matches.some((m) => m.sources.includes("local"))).toBe(true);
  expect(result.matches.some((m) => m.sources.includes("google"))).toBe(true);
  expect(result.conflicts?.matches.length).toBe(1);
});
it("provider-aware HTTP import remains CSRF protected and Outlook listing needs workspace auth", async () => {
  const f = await outlook();
  const session = await createSession(f.user.id);
  const app = createApp({ config, outlook: mail });
  expect((await request(app).get("/api/outlook/messages")).status).toBe(401);
  expect(
    (
      await request(app)
        .get("/api/outlook/messages")
        .set("Cookie", "hub_session=" + session.token)
    ).body.messages[0].subject,
  ).toBe("Synthetic Workshop");
  const rejected = await request(app)
    .post("/api/imports")
    .set("Cookie", "hub_session=" + session.token)
    .send({ provider: "outlook", externalIds: ["selected"] });
  expect(rejected.status).toBe(403);
  const accepted = await request(app)
    .post("/api/imports")
    .set("Cookie", "hub_session=" + session.token)
    .set("Origin", config.APP_ORIGIN)
    .set("x-csrf-token", session.csrf)
    .send({ provider: "outlook", externalIds: ["selected"] });
  expect(accepted.body.items[0].status).toBe("review");
});
