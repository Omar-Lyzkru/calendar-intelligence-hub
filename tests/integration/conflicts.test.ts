import { afterAll, expect, it, vi } from "vitest";
import { fixture } from "./helpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import {
  saveReview,
  approveReview,
} from "../../apps/api/src/application/approveReview.js";
import { checkDuplicates } from "../../apps/api/src/application/checkDuplicates.js";
import { createCalendarEvent } from "../../apps/api/src/application/createCalendarEvent.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import type { EventDraft, DuplicateRecord } from "@hub/contracts";
import type { CalendarGateway } from "../../apps/api/src/infrastructure/google/calendar.js";
afterAll(() => db.$disconnect());
const draft: EventDraft = {
  title: "Orion workshop",
  location: null,
  description: "PRIVATE CONTENT",
  category: "event",
  temporal: {
    kind: "timed",
    start: "2026-10-10T15:00:00.000Z",
    end: "2026-10-10T16:00:00.000Z",
    timezone: "America/Chicago",
  },
};
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
  return saveReview(f.actor, result.reviewId!, 1, { ...draft, ...changes });
}
function gateway(events: DuplicateRecord[] = []): CalendarGateway {
  return {
    list: vi.fn(async () => ({
      events,
      coverage: { status: "checked" as const },
    })),
    get: vi.fn(async () => null),
    insert: vi.fn(async (_a, id, _e, hash) => ({
      providerEventId: id,
      calendarId: "primary" as const,
      payloadHash: hash,
      htmlLink: "https://calendar.google.com/calendar/u/0/r",
    })),
  };
}
const live = (changes: Partial<DuplicateRecord> = {}): DuplicateRecord => ({
  key: "google:manual",
  source: "google",
  title: "Dentist appointment",
  location: null,
  temporal: draft.temporal,
  providerEventId: "manual",
  calendarId: "primary",
  availability: "busy",
  ...changes,
});
it("only owner-scoped immutable commitments conflict; drafts and duplicate warnings stay separate", async () => {
  const f = await fixture(),
    current = await add(f),
    committed = await add(f, { title: "Dentist appointment" }),
    mutable = await add(f, { title: "Other appointment" }),
    duplicate = await add(f, { title: "Orion workshop conference" });
  await approveReview(f.actor, committed.id, committed.revision);
  await approveReview(f.actor, duplicate.id, duplicate.revision);
  const foreign = await fixture(),
    other = await add(foreign, { title: "Private foreign event" });
  await approveReview(foreign.actor, other.id, other.revision);
  const before = await db.reviewItem.findUniqueOrThrow({
      where: { id: current.id },
    }),
    history = await db.historyEntry.count({ where: { userId: f.user.id } }),
    g = gateway();
  const r = await checkDuplicates(f.actor, current.id, current.revision, g);
  expect(r.conflicts?.matches.map((x) => x.reviewId)).toEqual([committed.id]);
  expect(r.matches.map((x) => x.reviewId)).toEqual([duplicate.id]);
  expect(r.conflicts?.matches.some((x) => x.reviewId === mutable.id)).toBe(
    false,
  );
  expect(
    await db.reviewItem.findUniqueOrThrow({ where: { id: current.id } }),
  ).toEqual(before);
  expect(await db.historyEntry.count({ where: { userId: f.user.id } })).toBe(
    history,
  );
  expect(g.list).toHaveBeenCalledTimes(1);
  expect(g.get).not.toHaveBeenCalled();
  expect(g.insert).not.toHaveBeenCalled();
  expect(JSON.stringify(r)).not.toMatch(
    /PRIVATE CONTENT|Private foreign|description/,
  );
});
it("unsaved corrected previews remove overlap while incomplete temporal candidates skip conflicts", async () => {
  const f = await fixture(),
    current = await add(f),
    g = gateway([live()]);
  const corrected = {
    ...draft,
    temporal: {
      kind: "timed" as const,
      start: "2026-10-10T16:00:00.000Z",
      end: "2026-10-10T17:00:00.000Z",
      timezone: "America/Chicago",
    },
  };
  expect(
    (await checkDuplicates(f.actor, current.id, current.revision, g)).conflicts
      ?.matches,
  ).toHaveLength(1);
  expect(
    (await checkDuplicates(f.actor, current.id, current.revision, g, corrected))
      .conflicts?.matches,
  ).toHaveLength(0);
  const incomplete = {
    ...draft,
    temporal: {
      kind: "date_only" as const,
      startDate: "2026-10-10",
      endDateInclusive: null,
    },
  };
  expect(
    (
      await checkDuplicates(
        f.actor,
        current.id,
        current.revision,
        g,
        incomplete,
      )
    ).conflicts?.google,
  ).toEqual({ status: "skipped", reason: "unresolved_time" });
  expect((await getReview(f.actor, current.id)).draft).toEqual(draft);
});
it("coalesces confirmed local/live commitments and lets moved/free live facts prevail", async () => {
  const f = await fixture(),
    current = await add(f),
    committed = await add(f, { title: "Dentist appointment" }),
    g = gateway();
  await approveReview(f.actor, committed.id, committed.revision);
  const receipt = await createCalendarEvent(f.actor, committed.id, g);
  g.list = vi.fn(async () => ({
    events: [live({ providerEventId: receipt.receipt!.providerEventId })],
    coverage: { status: "checked" as const },
  }));
  let r = await checkDuplicates(f.actor, current.id, current.revision, g);
  expect(r.conflicts?.matches).toHaveLength(1);
  expect(r.conflicts?.matches[0].sources).toEqual(["local", "google"]);
  g.list = vi.fn(async () => ({
    events: [
      live({
        providerEventId: receipt.receipt!.providerEventId,
        availability: "free",
      }),
    ],
    coverage: { status: "checked" as const },
  }));
  r = await checkDuplicates(f.actor, current.id, current.revision, g);
  expect(r.conflicts?.matches).toHaveLength(0);
  g.list = vi.fn(async () => ({
    events: [
      live({
        providerEventId: receipt.receipt!.providerEventId,
        temporal: {
          kind: "timed",
          start: "2026-10-10T17:00:00.000Z",
          end: "2026-10-10T18:00:00.000Z",
          timezone: "America/Chicago",
        },
      }),
    ],
    coverage: { status: "checked" as const },
  }));
  expect(
    (await checkDuplicates(f.actor, current.id, current.revision, g)).conflicts
      ?.matches,
  ).toHaveLength(0);
});
it("reports source failure and unknown all-day zone as incomplete, never clean", async () => {
  const f = await fixture(),
    current = await add(f),
    g = gateway([
      live({
        temporal: {
          kind: "all_day",
          startDate: "2026-10-10",
          endExclusive: "2026-10-11",
        },
      }),
    ]);
  let r = await checkDuplicates(f.actor, current.id, current.revision, g);
  expect(r.google.status).toBe("checked");
  expect(r.conflicts?.google).toEqual({
    status: "partial",
    reason: "unsupported_events",
  });
  g.list = vi.fn(async () => {
    throw Error("PRIVATE PROVIDER ERROR");
  });
  r = await checkDuplicates(f.actor, current.id, current.revision, g);
  expect(r.conflicts?.google.status).toBe("unavailable");
  expect(JSON.stringify(r)).not.toContain("PRIVATE PROVIDER");
});
it("caps warnings separately and preserves ready approval validation despite advisories", async () => {
  const f = await fixture(),
    current = await add(f),
    g = gateway(
      Array.from({ length: 21 }, (_, i) =>
        live({ key: "event" + i, providerEventId: "event" + i }),
      ),
    );
  const r = await checkDuplicates(f.actor, current.id, current.revision, g);
  expect(r.conflicts?.matches).toHaveLength(20);
  expect(r.conflicts?.truncated).toBe(true);
  expect(r.truncated).toBe(false);
  await approveReview(f.actor, current.id, current.revision);
  const approved = await getReview(f.actor, current.id);
  expect(approved.approvedSnapshot).toEqual(draft);
  expect(g.insert).not.toHaveBeenCalled();
});
it("does not coalesce unconfirmed intent IDs and skips already-added lookups", async () => {
  const f = await fixture(),
    current = await add(f),
    committed = await add(f, { title: "Dentist appointment" }),
    g = gateway();
  await approveReview(f.actor, committed.id, committed.revision);
  await createCalendarEvent(f.actor, committed.id, g);
  const intent = await db.calendarEvent.findUniqueOrThrow({
    where: { reviewItemId: committed.id },
  });
  await db.calendarEvent.update({
    where: { id: intent.id },
    data: { state: "unknown" },
  });
  await db.reviewItem.update({
    where: { id: committed.id },
    data: { status: "approved" },
  });
  g.list = vi.fn(async () => ({
    events: [live({ providerEventId: intent.providerEventId })],
    coverage: { status: "checked" as const },
  }));
  expect(
    (await checkDuplicates(f.actor, current.id, current.revision, g)).conflicts
      ?.matches,
  ).toHaveLength(2);
  await approveReview(f.actor, current.id, current.revision);
  await createCalendarEvent(f.actor, current.id, g);
  const added = await getReview(f.actor, current.id);
  g.list = vi.fn();
  const r = await checkDuplicates(f.actor, current.id, added.revision, g);
  expect(r.conflicts?.google).toEqual({
    status: "skipped",
    reason: "already_added",
  });
  expect(g.list).not.toHaveBeenCalled();
});
it("keeps a renamed confirmed live copy out of conflicts when its local copy is already a duplicate warning", async () => {
  const f = await fixture(),
    current = await add(f),
    committed = await add(f, { title: "Orion workshop conference" }),
    g = gateway();
  await approveReview(f.actor, committed.id, committed.revision);
  const outcome = await createCalendarEvent(f.actor, committed.id, g);
  g.list = vi.fn(async () => ({
    events: [
      live({
        title: "Renamed appointment",
        providerEventId: outcome.receipt!.providerEventId,
      }),
    ],
    coverage: { status: "checked" as const },
  }));
  const r = await checkDuplicates(f.actor, current.id, current.revision, g);
  expect(r.matches).toHaveLength(1);
  expect(r.conflicts!.matches).toHaveLength(0);
});
