import { it, expect, afterAll } from "vitest";
import { fixture } from "./helpers.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import {
  approveReview,
  saveReview,
} from "../../apps/api/src/application/approveReview.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import { createCalendarEvent } from "../../apps/api/src/application/createCalendarEvent.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import type { CalendarGateway } from "../../apps/api/src/infrastructure/google/calendar.js";
import { AppError, type CalendarReceipt } from "@hub/contracts";
afterAll(() => db.$disconnect());
async function review(approve = true) {
  const f = await fixture();
  const r = await saveProcessedMessage(
    f.actor,
    f.message,
    processMessage(f.message, "America/Chicago"),
  );
  const d = await getReview(f.actor, r.reviewId!);
  if (approve) {
    await saveReview(f.actor, d.id, 1, {
      ...d.draft,
      temporal: {
        kind: "all_day",
        startDate: "2026-10-08",
        endExclusive: "2026-10-09",
      },
    });
    await approveReview(f.actor, d.id, 2);
  }
  return { ...f, id: d.id };
}
function provider(loseResponse = false) {
  const records = new Map<string, CalendarReceipt>();
  let inserts = 0;
  const gateway: CalendarGateway = {
    get: async (_a, id) => records.get(id) || null,
    insert: async (_a, id, _e, hash) => {
      inserts++;
      expect(id).toMatch(/^[a-f0-9]{32}$/);
      const receipt = {
        providerEventId: id,
        calendarId: "primary",
        htmlLink: "https://calendar.google.com/calendar/event?eid=test",
        payloadHash: hash,
      };
      records.set(id, receipt);
      if (loseResponse) throw new AppError("provider_timeout", 503);
      return receipt;
    },
  };
  return { records, gateway, count: () => inserts };
}
it("unapproved_review_never_calls_google", async () => {
  const f = await review(false),
    p = provider();
  await expect(
    createCalendarEvent(f.actor, f.id, p.gateway),
  ).rejects.toMatchObject({ status: 409 });
  expect(p.count()).toBe(0);
});
it("concurrent_clicks_share_one_intent_and_repeat_returns_receipt", async () => {
  const f = await review(),
    p = provider();
  const results = await Promise.all([
    createCalendarEvent(f.actor, f.id, p.gateway),
    createCalendarEvent(f.actor, f.id, p.gateway),
  ]);
  expect(results.some((r) => r.status === "added")).toBe(true);
  expect((await createCalendarEvent(f.actor, f.id, p.gateway)).status).toBe(
    "added",
  );
  expect(p.count()).toBe(1);
  expect(await db.calendarEvent.count({ where: { reviewItemId: f.id } })).toBe(
    1,
  );
});
it("lost_response_reconciles_existing_event", async () => {
  const f = await review(),
    p = provider(true);
  expect((await createCalendarEvent(f.actor, f.id, p.gateway)).status).toBe(
    "unknown",
  );
  expect((await createCalendarEvent(f.actor, f.id, p.gateway)).status).toBe(
    "added",
  );
  expect(p.count()).toBe(1);
});
it("expired_lease_recovers_crash_after_insert", async () => {
  const f = await review(),
    p = provider();
  await createCalendarEvent(f.actor, f.id, p.gateway);
  await db.calendarEvent.update({
    where: { reviewItemId: f.id },
    data: { state: "writing", receipt: undefined, leaseUntil: new Date(0) },
  });
  await db.reviewItem.update({
    where: { id: f.id },
    data: { status: "writing" },
  });
  expect((await createCalendarEvent(f.actor, f.id, p.gateway)).status).toBe(
    "added",
  );
  expect(p.count()).toBe(1);
});
it("mismatched_existing_event_is_not_overwritten", async () => {
  const f = await review(),
    p = provider(true);
  await createCalendarEvent(f.actor, f.id, p.gateway);
  for (const [id, r] of p.records)
    p.records.set(id, { ...r, payloadHash: "wrong" });
  expect((await createCalendarEvent(f.actor, f.id, p.gateway)).reason).toBe(
    "event_mismatch",
  );
  expect(p.count()).toBe(1);
});
it("rate_limit_is_not_added", async () => {
  const f = await review();
  const p = provider();
  const g = {
    ...p.gateway,
    insert: async () => {
      throw new AppError("provider_rate_limited", 429);
    },
  };
  const r = await createCalendarEvent(f.actor, f.id, g);
  expect(r.status).not.toBe("added");
  expect((await getReview(f.actor, f.id)).status).not.toBe("added");
});
