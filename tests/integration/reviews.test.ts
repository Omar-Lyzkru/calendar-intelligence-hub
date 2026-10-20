import { it, expect, afterAll } from "vitest";
import { fixture } from "./helpers.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import {
  approveReview,
  saveReview,
  ignoreReview,
} from "../../apps/api/src/application/approveReview.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import { deleteContent } from "../../apps/api/src/infrastructure/persistence/retention.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
afterAll(() => db.$disconnect());
async function review() {
  const f = await fixture();
  const r = await saveProcessedMessage(
    f.actor,
    f.message,
    processMessage(f.message, "America/Chicago"),
  );
  return { ...f, review: await getReview(f.actor, r.reviewId!) };
}
it("missing_end_blocks_approval", async () => {
  const f = await review();
  await expect(approveReview(f.actor, f.review.id, 1)).rejects.toMatchObject({
    status: 422,
  });
  expect((await getReview(f.actor, f.review.id)).status).toBe("needs_review");
});
it("explicit_all_day_can_be_approved_and_snapshot_is_immutable", async () => {
  const f = await review();
  const draft = {
    ...f.review.draft,
    temporal: {
      kind: "all_day" as const,
      startDate: "2026-10-08",
      endExclusive: "2026-10-09",
    },
  };
  const saved = await saveReview(f.actor, f.review.id, 1, draft);
  const approved = await approveReview(f.actor, f.review.id, saved.revision);
  expect(approved.approvedSnapshot?.temporal.kind).toBe("all_day");
  expect(
    await db.calendarEvent.count({ where: { reviewItemId: f.review.id } }),
  ).toBe(0);
  await expect(
    saveReview(f.actor, f.review.id, approved.revision, {
      ...draft,
      title: "changed",
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("stale_edit_or_approval_returns_409", async () => {
  const f = await review();
  await saveReview(f.actor, f.review.id, 1, f.review.draft);
  await expect(
    saveReview(f.actor, f.review.id, 1, f.review.draft),
  ).rejects.toMatchObject({ status: 409 });
  await expect(approveReview(f.actor, f.review.id, 1)).rejects.toMatchObject({
    status: 409,
  });
});
it("foreign_review_returns_404", async () => {
  const f = await review(),
    other = await fixture();
  await expect(
    saveReview(other.actor, f.review.id, 1, f.review.draft),
  ).rejects.toMatchObject({ status: 404 });
});
it("ignore_records_history", async () => {
  const f = await review();
  expect((await ignoreReview(f.actor, f.review.id, 1)).status).toBe("ignored");
  expect(
    await db.historyEntry.count({
      where: { userId: f.actor.userId, action: "review_ignored" },
    }),
  ).toBe(1);
});
it("delete_content_checks_ownership", async () => {
  const f = await review(),
    other = await fixture();
  await expect(
    deleteContent(other.user.id, f.message.id),
  ).rejects.toMatchObject({ status: 404 });
});

import { vi } from "vitest";
import { Prisma } from "@prisma/client";
it("save_response_cannot_adopt_an_intervening_edit", async () => {
  const f = await review();
  const draft = {
    ...f.review.draft,
    title: "My approved title",
    temporal: {
      kind: "all_day" as const,
      startDate: "2026-10-08",
      endExclusive: "2026-10-09",
    },
  };
  const original = db.$transaction.bind(db) as (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>;
  const spy = vi.spyOn(db, "$transaction").mockImplementationOnce((async (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    const result = await original(callback);
    await db.reviewItem.update({
      where: { id: f.review.id },
      data: {
        revision: { increment: 1 },
        draft: { ...draft, title: "Another tab title" },
      },
    });
    return result;
  }) as typeof db.$transaction);
  let saved;
  try {
    saved = await saveReview(f.actor, f.review.id, 1, draft);
  } finally {
    spy.mockRestore();
  }
  expect(saved.revision).toBe(2);
  expect(saved.draft.title).toBe("My approved title");
  await expect(
    approveReview(f.actor, f.review.id, saved.revision),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    await db.calendarEvent.count({ where: { reviewItemId: f.review.id } }),
  ).toBe(0);
});
