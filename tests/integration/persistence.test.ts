import { it, expect, afterAll } from "vitest";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import {
  purgeExpiredContent,
  deleteContent,
} from "../../apps/api/src/infrastructure/persistence/retention.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import { fixture } from "./helpers.js";
afterAll(() => db.$disconnect());
it("same_connection_message_is_unique_and_reimport_preserves_edits", async () => {
  const f = await fixture();
  const r = await saveProcessedMessage(
    f.actor,
    f.message,
    processMessage(f.message, "America/Chicago"),
  );
  const again = await saveProcessedMessage(
    f.actor,
    { ...f.message, id: crypto.randomUUID() },
    processMessage(f.message, "America/Chicago"),
  );
  expect(again.reviewId).toBe(r.reviewId);
  expect(
    await db.normalizedMessage.count({ where: { userId: f.user.id } }),
  ).toBe(1);
});
it("same_external_id_different_connections_is_allowed", async () => {
  const a = await fixture(),
    b = await fixture();
  await saveProcessedMessage(a.actor, a.message, {
    kind: "no_event",
    reasons: [],
  });
  await saveProcessedMessage(b.actor, b.message, {
    kind: "no_event",
    reasons: [],
  });
  expect(
    await db.normalizedMessage.count({
      where: { externalId: "test", userId: { in: [a.user.id, b.user.id] } },
    }),
  ).toBe(2);
});
it("cross_user_read_returns_not_found", async () => {
  const f = await fixture(),
    other = await fixture();
  const r = await saveProcessedMessage(
    f.actor,
    f.message,
    processMessage(f.message, "America/Chicago"),
  );
  await expect(getReview(other.actor, r.reviewId!)).rejects.toMatchObject({
    status: 404,
  });
});
it("processing_failure_rolls_back_candidate", async () => {
  const f = await fixture();
  await expect(
    saveProcessedMessage(
      f.actor,
      { ...f.message, sourceConnectionId: crypto.randomUUID() },
      processMessage(f.message, "America/Chicago"),
    ),
  ).rejects.toThrow();
  expect(
    await db.normalizedMessage.count({ where: { id: f.message.id } }),
  ).toBe(0);
});
it("expired_content_is_unreadable_and_purged", async () => {
  const f = await fixture();
  const r = await saveProcessedMessage(
    f.actor,
    f.message,
    processMessage(f.message, "America/Chicago"),
  );
  const detail = await getReview(
    f.actor,
    r.reviewId!,
    new Date("2026-11-06T12:00:00Z"),
  );
  expect(detail.originalText).toBeNull();
  expect(detail.candidate.evidence.every((e) => !e.text)).toBe(true);
  expect(
    detail.candidate.draft.temporal.kind === "unresolved"
      ? detail.candidate.draft.temporal.text
      : "",
  ).toBe("");
  await purgeExpiredContent(new Date("2026-11-06T12:00:00Z"));
  expect(
    (await db.normalizedMessage.findUnique({ where: { id: f.message.id } }))
      ?.content,
  ).toBeNull();
});
it("local_delete_erases_content_and_evidence", async () => {
  const f = await fixture();
  const r = await saveProcessedMessage(
    f.actor,
    f.message,
    processMessage(f.message, "America/Chicago"),
  );
  await deleteContent(f.user.id, f.message.id);
  const d = await getReview(
    f.actor,
    r.reviewId!,
    new Date("2026-10-08T00:00:00Z"),
  );
  expect(d.originalText).toBeNull();
  expect(d.candidate.evidence.every((e) => !e.text)).toBe(true);
  expect(
    await db.historyEntry.count({ where: { userId: f.user.id } }),
  ).toBeGreaterThan(0);
});

import { vi } from "vitest";
import { Prisma } from "@prisma/client";
import { saveReview } from "../../apps/api/src/application/approveReview.js";
it("content_cleanup_preserves_a_concurrent_correction", async () => {
  const f = await fixture();
  const message = { ...f.message, content: "Workshop next Friday" };
  const r = await saveProcessedMessage(
    f.actor,
    message,
    processMessage(message, "America/Chicago"),
  );
  const draft = {
    title: "Corrected title",
    category: "event" as const,
    location: null,
    description: null,
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
  ) =>
    original(async (tx) => {
      const read = tx.normalizedMessage.findFirst.bind(tx.normalizedMessage);
      const readSpy = vi
        .spyOn(tx.normalizedMessage, "findFirst")
        .mockImplementationOnce((async (args: Parameters<typeof read>[0]) => {
          const found = await read(args);
          await saveReview(f.actor, r.reviewId!, 1, draft);
          return found;
        }) as typeof read);
      try {
        return await callback(tx);
      } finally {
        readSpy.mockRestore();
      }
    })) as typeof db.$transaction);
  try {
    await deleteContent(f.user.id, f.message.id);
  } finally {
    spy.mockRestore();
  }
  const detail = await getReview(f.actor, r.reviewId!);
  expect(detail.draft.title).toBe("Corrected title");
  expect(detail.draft.temporal.kind).toBe("all_day");
  expect(detail.revision).toBe(2);
  expect(detail.originalText).toBeNull();
});
