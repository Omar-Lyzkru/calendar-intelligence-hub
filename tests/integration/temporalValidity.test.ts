import { it, expect, afterAll } from "vitest";
import { fixture } from "./helpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import {
  approveReview,
  saveReview,
} from "../../apps/api/src/application/approveReview.js";
import { deleteContent } from "../../apps/api/src/infrastructure/persistence/retention.js";
import { createCalendarEvent } from "../../apps/api/src/application/createCalendarEvent.js";
afterAll(() => db.$disconnect());
it("date_only_saves_but_blocks_approval_then_explicit_correction_can_be_approved", async () => {
  const f = await fixture(),
    message = {
      ...f.message,
      subject: "Workshop October 20, 2026",
      content: "Details to follow",
    };
  const result = await saveProcessedMessage(
    f.actor,
    message,
    processMessage(message, "America/Chicago"),
  );
  const before = await getReview(f.actor, result.reviewId!);
  expect(before.draft.temporal.kind).toBe("date_only");
  expect(before.candidate.evidence.some((e) => e.origin === "subject")).toBe(
    true,
  );
  await expect(
    approveReview(f.actor, before.id, before.revision),
  ).rejects.toMatchObject({ status: 422 });
  const saved = await saveReview(f.actor, before.id, before.revision, {
    ...before.draft,
    temporal: {
      kind: "all_day",
      startDate: "2026-10-20",
      endExclusive: "2026-10-21",
    },
  });
  const approved = await approveReview(f.actor, before.id, saved.revision);
  expect(approved.approvedSnapshot?.temporal.kind).toBe("all_day");
  expect(
    await db.calendarEvent.count({ where: { reviewItemId: before.id } }),
  ).toBe(0);
  await deleteContent(f.user.id, message.id);
  const after = await getReview(f.actor, before.id);
  expect(after.originalText).toBeNull();
  expect(
    after.candidate.evidence.every(
      (e) =>
        e.text === undefined && e.start === undefined && e.end === undefined,
    ),
  ).toBe(true);
  expect(after.approvedSnapshot).toEqual(approved.approvedSnapshot);
});
it("legacy_candidate_has_no_guessed_provenance_and_reimport_preserves_it", async () => {
  const f = await fixture(),
    candidate = processMessage(f.message, "America/Chicago");
  if (candidate.kind !== "review") throw Error();
  candidate.candidate.extractionVersion = 1;
  const t = candidate.candidate.draft.temporal;
  if (t.kind === "timed" || t.kind === "unresolved")
    delete t.timezoneProvenance;
  const first = await saveProcessedMessage(f.actor, f.message, candidate),
    second = await saveProcessedMessage(
      f.actor,
      f.message,
      processMessage(f.message, "America/Chicago"),
    );
  expect(second.reviewId).toBe(first.reviewId);
  const review = await getReview(f.actor, first.reviewId!);
  expect(review.candidate.extractionVersion).toBe(1);
  expect(review.draft.temporal).not.toHaveProperty("timezoneProvenance");
});
it("invalid_stored_snapshot_never_reaches_provider", async () => {
  const f = await fixture(),
    r = await saveProcessedMessage(
      f.actor,
      f.message,
      processMessage(f.message, "America/Chicago"),
    );
  await db.reviewItem.update({
    where: { id: r.reviewId },
    data: {
      status: "approved",
      approvedSnapshot: {
        title: "Bad",
        location: null,
        description: null,
        category: "event",
        temporal: {
          kind: "all_day",
          startDate: "2026-02-30",
          endExclusive: "2026-03-03",
        },
      },
    },
  });
  let calls = 0;
  await expect(
    createCalendarEvent(f.actor, r.reviewId!, {
      get: async () => {
        calls++;
        return null;
      },
      insert: async () => {
        calls++;
        throw Error();
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  expect(
    await db.calendarEvent.count({ where: { reviewItemId: r.reviewId } }),
  ).toBe(0);
});
it("incomplete reviewer date range and entered end roundtrip without source text metadata", async () => {
  const f = await fixture(),
    r = await saveProcessedMessage(
      f.actor,
      f.message,
      processMessage(f.message, "America/Chicago"),
    );
  const before = await getReview(f.actor, r.reviewId!);
  const temporal = {
    kind: "unresolved" as const,
    text: "",
    timezone: "America/Chicago",
    partial: {
      year: 2026,
      month: 12,
      day: 31,
      endDateInclusive: "2027-01-02",
      endInstant: "2027-01-02T21:15:12.345Z",
    },
  };
  const saved = await saveReview(f.actor, before.id, before.revision, {
    ...before.draft,
    temporal,
  });
  expect(saved.draft.temporal).toEqual(temporal);
  await expect(
    approveReview(f.actor, before.id, saved.revision),
  ).rejects.toMatchObject({ status: 422 });
  await deleteContent(f.user.id, f.message.id);
  expect((await getReview(f.actor, before.id)).draft.temporal).toEqual(
    temporal,
  );
});
it("literal Phase1 snapshot hash receipt and intent survive creation replay and reimport", async () => {
  const f = await fixture(),
    first = await saveProcessedMessage(
      f.actor,
      f.message,
      processMessage(f.message, "America/Chicago"),
    );
  const snapshot = {
    title: "Workshop",
    location: null,
    description: null,
    category: "event",
    temporal: {
      kind: "timed",
      start: "2026-10-08T19:00:00.123Z",
      end: "2026-10-08T20:00:00.123Z",
      timezone: "America/Chicago",
    },
  };
  await db.reviewItem.update({
    where: { id: first.reviewId },
    data: { draft: snapshot, approvedSnapshot: snapshot, status: "approved" },
  });
  let gets = 0,
    inserts = 0;
  const gateway = {
    get: async () => {
      gets++;
      return null;
    },
    insert: async (
      _actor: unknown,
      id: string,
      _event: unknown,
      hash: string,
    ) => {
      inserts++;
      expect(hash).toBe(
        "c7908948292d0be6c1fb746e7995478281f401d393096748eb8c8e38d81d6d63",
      );
      return {
        providerEventId: id,
        calendarId: "primary",
        htmlLink: "https://calendar.google.com/calendar/u/0/r",
        payloadHash: hash,
      };
    },
  };
  const created = await createCalendarEvent(f.actor, first.reviewId!, gateway);
  expect(created.status).toBe("added");
  const before = await db.calendarEvent.findUniqueOrThrow({
    where: { reviewItemId: first.reviewId },
  });
  const again = await saveProcessedMessage(
    f.actor,
    f.message,
    processMessage(f.message, "America/New_York"),
  );
  expect(again.reviewId).toBe(first.reviewId);
  expect(await createCalendarEvent(f.actor, first.reviewId!, gateway)).toEqual(
    created,
  );
  const after = await db.calendarEvent.findUniqueOrThrow({
    where: { reviewItemId: first.reviewId },
  });
  expect(after).toEqual(before);
  expect(after.payload).toEqual(snapshot);
  const review = await getReview(f.actor, first.reviewId!);
  expect(review.approvedSnapshot).toEqual(snapshot);
  expect(review.approvedSnapshot!.temporal).not.toHaveProperty(
    "timezoneProvenance",
  );
  expect(gets).toBe(1);
  expect(inserts).toBe(1);
});
