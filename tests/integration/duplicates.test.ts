import { afterAll, expect, it, vi } from "vitest";
import request from "supertest";
import { fixture } from "./helpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import {
  saveReview,
  approveReview,
  ignoreReview,
} from "../../apps/api/src/application/approveReview.js";
import { createCalendarEvent } from "../../apps/api/src/application/createCalendarEvent.js";
import { createApp } from "../../apps/api/src/app.js";
import { createSession } from "../../apps/api/src/infrastructure/sessions/store.js";
import * as checking from "../../apps/api/src/application/checkDuplicates.js";
import {
  AppError,
  DuplicateCheckSchema,
  type EventDraft,
} from "@hub/contracts";
import type { CalendarGateway } from "../../apps/api/src/infrastructure/google/calendar.js";
afterAll(() => db.$disconnect());
const draft: EventDraft = {
  title: "CodeRED Orion",
  location: null,
  description: "PRIVATE SOURCE SENTINEL",
  category: "event",
  temporal: {
    kind: "timed",
    start: "2026-10-10T15:00:00.000Z",
    end: "2026-10-10T16:00:00.000Z",
    timezone: "America/Chicago",
  },
};
const gateway = (): CalendarGateway => ({
  get: vi.fn(async () => null),
  insert: vi.fn(async (_a, id, _e, hash) => ({
    providerEventId: id,
    calendarId: "primary" as const,
    payloadHash: hash,
    htmlLink: "https://calendar.google.com/calendar/u/0/r",
  })),
  list: vi.fn(async () => ({
    events: [],
    coverage: { status: "checked" as const },
  })),
});
async function add(
  f: Awaited<ReturnType<typeof fixture>>,
  changes: Partial<EventDraft> = {},
) {
  const m = {
    ...f.message,
    id: crypto.randomUUID(),
    externalId: crypto.randomUUID(),
  };
  const result = await saveProcessedMessage(
    f.actor,
    m,
    processMessage(m, "America/Chicago"),
  );
  const r = await saveReview(f.actor, result.reviewId!, 1, {
    ...draft,
    ...changes,
  });
  return { id: r.id, revision: r.revision, m };
}
it("checks own local candidates and immutable approvals without persisting checks or leaking source content", async () => {
  const f = await fixture(),
    current = await add(f),
    other = await add(f, { title: "CodeRED Orion Hackathon" });
  await approveReview(f.actor, other.id, other.revision);
  const foreign = await fixture();
  await add(foreign);
  const ignored = await add(f);
  await ignoreReview(f.actor, ignored.id, ignored.revision);
  const different = await add(f, {
    temporal: {
      ...draft.temporal,
      kind: "timed",
      start: "2026-10-17T15:00:00.000Z",
      end: "2026-10-17T16:00:00.000Z",
      timezone: "America/Chicago",
    },
  });
  const before = await db.reviewItem.findUniqueOrThrow({
    where: { id: current.id },
  });
  const history = await db.historyEntry.count({ where: { userId: f.user.id } });
  const g = gateway(),
    r = await checking.checkDuplicates(
      f.actor,
      current.id,
      current.revision,
      g,
    );
  expect(DuplicateCheckSchema.safeParse(r).success).toBe(true);
  expect(r.matches).toHaveLength(1);
  expect(r.matches[0]).toMatchObject({
    reviewId: other.id,
    strength: "strong_possible",
    sources: ["local"],
  });
  expect(r.matches.some((x) => x.reviewId === different.id)).toBe(false);
  expect(r.local.status).toBe("checked");
  expect(JSON.stringify(r)).not.toMatch(
    /PRIVATE SOURCE|description|originalText|externalId/,
  );
  expect(
    await db.reviewItem.findUniqueOrThrow({ where: { id: current.id } }),
  ).toEqual(before);
  expect(await db.historyEntry.count({ where: { userId: f.user.id } })).toBe(
    history,
  );
  expect(g.insert).not.toHaveBeenCalled();
  expect(g.get).not.toHaveBeenCalled();
});
it("a current confirmed receipt is protected and skips unnecessary live reads; repeated source and write stay stable", async () => {
  const f = await fixture(),
    current = await add(f),
    g = gateway();
  await approveReview(f.actor, current.id, current.revision);
  const first = await createCalendarEvent(f.actor, current.id, g);
  const d = await getReview(f.actor, current.id);
  const r = await checking.checkDuplicates(f.actor, current.id, d.revision, g);
  expect(r.matches[0]).toMatchObject({
    strength: "exact_identity",
    evidence: expect.arrayContaining(["same_provider_event"]),
  });
  expect(r.google).toEqual({ status: "skipped", reason: "already_added" });
  expect(g.list).not.toHaveBeenCalled();
  expect(await createCalendarEvent(f.actor, current.id, g)).toEqual(first);
  expect(g.insert).toHaveBeenCalledTimes(1);
  const repeat = await saveProcessedMessage(
    f.actor,
    current.m,
    processMessage(current.m, "America/Chicago"),
  );
  expect(repeat.reviewId).toBe(current.id);
});
it("manual Google matches are advisory, multiple matches remain visible, and linked receipts coalesce", async () => {
  const f = await fixture(),
    current = await add(f),
    other = await add(f),
    g = gateway();
  await approveReview(f.actor, other.id, other.revision);
  const created = await createCalendarEvent(f.actor, other.id, g);
  const id = created.receipt!.providerEventId;
  g.list = vi.fn(async () => ({
    events: [
      {
        key: "google:" + id,
        source: "google" as const,
        title: draft.title,
        location: null,
        temporal: draft.temporal,
        calendarId: "primary" as const,
        providerEventId: id,
      },
      {
        key: "manual",
        source: "google" as const,
        title: "CodeRED Orion Hackathon",
        location: null,
        temporal: draft.temporal,
        providerEventId: "manual",
        calendarId: "primary" as const,
      },
    ],
    coverage: { status: "checked" as const },
  }));
  const r = await checking.checkDuplicates(
    f.actor,
    current.id,
    current.revision,
    g,
  );
  expect(r.matches).toHaveLength(2);
  expect(
    r.matches.find((m) => m.providerEventId === id)?.sources.sort(),
  ).toEqual(["google", "local"]);
  expect(r.matches.find((m) => m.providerEventId === "manual")?.strength).toBe(
    "strong_possible",
  );
  expect(
    await approveReview(f.actor, current.id, current.revision),
  ).toMatchObject({ status: "approved" });
});
it("provider unavailable, absent adapter and unresolved dates never report a clean Google check", async () => {
  const f = await fixture(),
    current = await add(f),
    g = gateway();
  g.list = vi.fn(async () => {
    throw Error("TOKEN SECRET SENTINEL");
  });
  const r = await checking.checkDuplicates(
    f.actor,
    current.id,
    current.revision,
    g,
  );
  expect(r.google).toEqual({
    status: "unavailable",
    reason: "provider_unavailable",
  });
  expect(JSON.stringify(r)).not.toContain("SECRET");
  delete g.list;
  expect(
    (await checking.checkDuplicates(f.actor, current.id, current.revision, g))
      .google.status,
  ).toBe("unavailable");
  g.list = vi.fn();
  const unresolved = {
    ...draft,
    temporal: {
      kind: "unresolved" as const,
      text: "next Friday",
      timezone: "America/Chicago",
    },
  };
  const skipped = await checking.checkDuplicates(
    f.actor,
    current.id,
    current.revision,
    g,
    unresolved,
  );
  expect(skipped.window).toBeNull();
  expect(skipped.google.status).toBe("skipped");
  expect(g.list).not.toHaveBeenCalled();
});
it("foreign, corrupt-source, locked and stale previews are rejected before or after read", async () => {
  const f = await fixture(),
    current = await add(f),
    foreign = await fixture(),
    g = gateway();
  await expect(
    checking.checkDuplicates(foreign.actor, current.id, current.revision, g),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    checking.checkDuplicates(f.actor, current.id, 1, g),
  ).rejects.toMatchObject({ code: "stale_review" });
  g.list = vi.fn(async () => {
    await saveReview(f.actor, current.id, current.revision, {
      ...draft,
      title: "Changed",
    });
    return { events: [], coverage: { status: "checked" as const } };
  });
  await expect(
    checking.checkDuplicates(f.actor, current.id, current.revision, g),
  ).rejects.toMatchObject({ code: "stale_review" });
  expect(g.insert).not.toHaveBeenCalled();
  await db.normalizedMessage.update({
    where: { id: current.m.id },
    data: { userId: foreign.user.id },
  });
  await expect(
    checking.checkDuplicates(
      f.actor,
      current.id,
      current.revision + 1,
      gateway(),
    ),
  ).rejects.toMatchObject({ code: "record_integrity_error" });
  const locked = await add(f);
  await approveReview(f.actor, locked.id, locked.revision);
  await expect(
    checking.checkDuplicates(
      f.actor,
      locked.id,
      locked.revision + 1,
      gateway(),
      draft,
    ),
  ).rejects.toMatchObject({ code: "review_locked" });
});
it("date-only preview matches all-day locally without turning candidate into midnight", async () => {
  const f = await fixture(),
    current = await add(f);
  await add(f, {
    temporal: {
      kind: "all_day",
      startDate: "2026-10-10",
      endExclusive: "2026-10-11",
    },
  });
  const r = await checking.checkDuplicates(
    f.actor,
    current.id,
    current.revision,
    gateway(),
    {
      ...draft,
      temporal: {
        kind: "date_only",
        startDate: "2026-10-10",
        endDateInclusive: null,
      },
    },
  );
  expect(r.matches[0].strength).toBe("possible");
  expect(r.matches[0].evidence).toContain("date_only_unconfirmed");
});
it("endpoint requires actor/CSRF and returns a validated preview without writing", async () => {
  const f = await fixture(),
    current = await add(f),
    g = gateway();
  const config = {
    NODE_ENV: "test" as const,
    PORT: 3000,
    APP_ORIGIN: "http://localhost:5173",
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    GOOGLE_CLIENT_ID: "synthetic",
    GOOGLE_CLIENT_SECRET: "synthetic",
    GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
    TOKEN_ENCRYPTION_KEY: "1".repeat(64),
    PROVIDER_TIMEOUT_MS: 1000,
  };
  const app = createApp({ config, calendar: g }),
    path = "/api/reviews/" + current.id + "/duplicates";
  expect(
    (await request(app).post(path).send({ expectedRevision: current.revision }))
      .status,
  ).toBe(403);
  const s = await createSession(f.user.id),
    cookie = "hub_session=" + s.token;
  const response = await request(app)
    .post(path)
    .set("Cookie", cookie)
    .set("Origin", config.APP_ORIGIN)
    .set("x-csrf-token", s.csrf)
    .send({ expectedRevision: current.revision, draft });
  expect(response.status).toBe(200);
  expect(DuplicateCheckSchema.safeParse(response.body).success).toBe(true);
  expect(
    (
      await request(app)
        .post(path)
        .set("Cookie", cookie)
        .send({ expectedRevision: current.revision })
    ).status,
  ).toBe(403);
});

it.each(["timed", "all_day"] as const)(
  "invalid local %s interval marks coverage incomplete rather than clean",
  async (kind) => {
    const f = await fixture(),
      current = await add(f),
      other = await add(f);
    const temporal =
      kind === "timed"
        ? {
            kind,
            start: "2026-10-10T15:00:00.000Z",
            end: "2026-10-10T14:00:00.000Z",
            timezone: "America/Chicago",
          }
        : { kind, startDate: "2026-10-10", endExclusive: "2026-10-09" };
    await db.reviewItem.update({
      where: { id: other.id },
      data: { draft: { ...draft, temporal } },
    });
    const r = await checking.checkDuplicates(
      f.actor,
      current.id,
      current.revision,
      gateway(),
    );
    expect(r.local).toEqual({
      status: "partial",
      reason: "unsupported_events",
    });
    expect(r.matches).toHaveLength(0);
  },
);

it.each(["unknown", "failed"] as const)(
  "unconfirmed %s write IDs never become exact duplicate identity",
  async (state) => {
    const f = await fixture(),
      current = await add(f),
      g = gateway();
    const approved = await approveReview(f.actor, current.id, current.revision);
    g.insert = vi.fn(async () => {
      throw new AppError(
        state === "failed" ? "reauthorization_required" : "provider_timeout",
        503,
      );
    });
    await createCalendarEvent(f.actor, current.id, g);
    const write = await db.calendarEvent.findUniqueOrThrow({
      where: { reviewItemId: current.id },
    });
    const before = await getReview(f.actor, current.id);
    expect(before.write?.status).toBe(state);
    g.list = async () => ({
      events: [
        {
          key: "reserved",
          source: "google",
          title: "Completely unrelated",
          location: null,
          temporal: draft.temporal,
          providerEventId: write.providerEventId,
          calendarId: "primary",
        },
      ],
      coverage: { status: "checked" },
    });
    const r = await checking.checkDuplicates(
      f.actor,
      current.id,
      approved.revision,
      g,
    );
    expect(r.matches).toHaveLength(0);
    expect(await getReview(f.actor, current.id)).toEqual(before);
    expect(g.insert).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "empty_receipt",
  "receipt_id",
  "receipt_hash",
  "snapshot_hash",
] as const)(
  "malformed confirmed association %s makes local coverage partial",
  async (kind) => {
    const f = await fixture(),
      current = await add(f),
      other = await add(f),
      g = gateway();
    await approveReview(f.actor, other.id, other.revision);
    const outcome = await createCalendarEvent(f.actor, other.id, g);
    const snapshot = (await getReview(f.actor, other.id)).approvedSnapshot;
    const receipt = outcome.receipt!;
    const data =
      kind === "snapshot_hash"
        ? { payloadHash: "wrong" }
        : {
            receipt:
              kind === "empty_receipt"
                ? {}
                : kind === "receipt_id"
                  ? { ...receipt, providerEventId: "different" }
                  : { ...receipt, payloadHash: "wrong" },
          };
    await db.calendarEvent.update({ where: { reviewItemId: other.id }, data });
    const r = await checking.checkDuplicates(
      f.actor,
      current.id,
      current.revision,
      g,
    );
    expect(r.local).toEqual({
      status: "partial",
      reason: "unsupported_events",
    });
    expect(r.matches).toHaveLength(0);
    expect(
      (await db.reviewItem.findUniqueOrThrow({ where: { id: other.id } }))
        .approvedSnapshot,
    ).toEqual(snapshot);
  },
);
