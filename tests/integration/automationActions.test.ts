import { it, expect, afterAll } from "vitest";
import { fixture } from "./helpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import {
  getPolicy,
  savePolicy,
} from "../../apps/api/src/application/automation/policyStore.js";
import { evaluateReview } from "../../apps/api/src/application/automation/engine.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import {
  approveReview,
  saveReview,
} from "../../apps/api/src/application/approveReview.js";
import { createCalendarEvent } from "../../apps/api/src/application/createCalendarEvent.js";
import type { CalendarGateway } from "../../apps/api/src/infrastructure/google/calendar.js";
import { AppError, type CalendarReceipt } from "@hub/contracts";
afterAll(() => db.$disconnect());
import { setup, provider } from "./automationHelpers.js";
it("eligible opt-in commitment uses immutable approval and shared writer exactly once", async () => {
  const f = await setup(),
    p = provider();
  const d = await evaluateReview(f.actor, f.id, p.gateway, {
    allowWrites: true,
  });
  expect(d.reason).toBe("added");
  expect(p.count()).toBe(1);
  expect((await getReview(f.actor, f.id)).approvedSnapshot?.title).toBe(
    "Synthetic Exam",
  );
});
it("operator gate defaults closed even when user explicitly enables policy", async () => {
  const f = await setup(),
    p = provider();
  expect((await evaluateReview(f.actor, f.id, p.gateway)).reason).toBe(
    "live_acceptance_required",
  );
  expect(p.count()).toBe(0);
  expect((await getReview(f.actor, f.id)).status).toBe("needs_review");
});
it("disabled policy never calls Calendar insert", async () => {
  const f = await setup(false),
    p = provider();
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("automation_disabled");
  expect(p.count()).toBe(0);
});
it("enabling never enrolls an old source", async () => {
  const f = await setup(),
    p = provider();
  await db.normalizedMessage.update({
    where: { id: f.message.id },
    data: { receivedAt: new Date(0) },
  });
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("historical");
  expect(p.count()).toBe(0);
});
it("one hundred concurrent evaluations and restarts preserve one receipt and insert", async () => {
  const f = await setup(),
    p = provider();
  await Promise.all(
    Array.from({ length: 100 }, () =>
      evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }),
    ),
  );
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  expect(p.count()).toBe(1);
  expect(await db.calendarEvent.count({ where: { reviewItemId: f.id } })).toBe(
    1,
  );
});
it("lost Calendar response remains unknown then reconciles the same event", async () => {
  const f = await setup(),
    p = provider();
  p.lose();
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("action_unknown");
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("added");
  expect(p.count()).toBe(1);
});
it("expired automatic write lease recovers without another insert", async () => {
  const f = await setup(),
    p = provider();
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  await db.calendarEvent.update({
    where: { reviewItemId: f.id },
    data: { state: "writing", leaseUntil: new Date(0) },
  });
  await db.reviewItem.update({
    where: { id: f.id },
    data: { status: "writing" },
  });
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("added");
  expect(p.count()).toBe(1);
});
it("failed duplicate read blocks even when conflict facts could otherwise be clear", async () => {
  const f = await setup(),
    p = provider();
  p.gateway.list = async () => {
    throw new AppError("provider_timeout", 503);
  };
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("checks_unavailable");
  expect(p.count()).toBe(0);
});
it("policy changed during provider read cannot authorize a stale write", async () => {
  const f = await setup(),
    p = provider();
  p.gateway.list = async () => {
    await db.automationPolicy.update({
      where: { userId: f.user.id },
      data: { revision: { increment: 1 }, enabled: false, enabledAt: null },
    });
    return { events: [], coverage: { status: "checked" } };
  };
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("stale");
  expect(p.count()).toBe(0);
});
it("review edited during provider read cannot authorize stale approval", async () => {
  const f = await setup(),
    p = provider();
  p.gateway.list = async () => {
    const r = await getReview(f.actor, f.id);
    await saveReview(f.actor, f.id, r.revision, {
      ...r.draft,
      title: "Corrected exam",
    });
    return { events: [], coverage: { status: "checked" } };
  };
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("stale");
  expect(p.count()).toBe(0);
});
it("disconnect during provider checks stops the new action", async () => {
  const f = await setup(),
    p = provider();
  p.gateway.list = async () => {
    await db.sourceConnection.update({
      where: { id: f.connection.id },
      data: { status: "disconnected" },
    });
    return { events: [], coverage: { status: "checked" } };
  };
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("source_unavailable");
  expect(p.count()).toBe(0);
});
it("manual write racing automatic recovery shares the same event intent", async () => {
  const f = await setup(),
    p = provider();
  p.lose();
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  await Promise.all([
    createCalendarEvent(f.actor, f.id, p.gateway),
    evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }),
  ]);
  expect(p.count()).toBe(1);
});
it("a manually approved commitment is never silently adopted by automation", async () => {
  const f = await setup(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await approveReview(f.actor, f.id, r.revision);
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("manual_state");
  expect(p.count()).toBe(0);
});
it("cross-provider candidates share duplicate intelligence and cannot both auto-insert", async () => {
  const f = await setup(),
    p = provider();
  const relay = await db.discordRelay.create({
    data: {
      userId: f.user.id,
      guildId: (
        800000000000000000n +
        BigInt("0x" + crypto.randomUUID().replaceAll("-", "").slice(0, 14))
      ).toString(),
      channelIds: ["800000000000000002"],
    },
  });
  const c = await db.sourceConnection.create({
    data: {
      userId: f.user.id,
      provider: "discord",
      discordRelayId: relay.id,
      externalAccountId: relay.guildId,
    },
  });
  const other = {
    ...f.message,
    id: crypto.randomUUID(),
    sourceConnectionId: c.id,
    source: "discord" as const,
    externalId: "different-provider-source",
  };
  await saveProcessedMessage(
    f.actor,
    other,
    processMessage(other, "America/Chicago"),
  );
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("possible_duplicate");
  expect(p.count()).toBe(0);
});
it("persisted decisions contain structured evidence rather than private source text", async () => {
  const f = await setup(),
    p = provider();
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  const row = await db.automationDecision.findUniqueOrThrow({
    where: { reviewId: f.id },
  });
  expect(JSON.stringify(row)).not.toContain("PRIVATE_SOURCE_SENTINEL");
  expect(row.policyRevision).toBeGreaterThan(1);
  expect(row.reason).toBe("added");
});
it("foreign user cannot evaluate or configure another source", async () => {
  const f = await setup(),
    other = await fixture(),
    p = provider();
  await expect(
    evaluateReview(other.actor, f.id, p.gateway, { allowWrites: true }),
  ).rejects.toMatchObject({ code: "not_found" });
  const policy = await getPolicy(other.actor);
  await expect(
    savePolicy(other.actor, policy.revision, {
      enabled: true,
      pollGmail: false,
      rules: [
        {
          connectionId: f.connection.id,
          category: "exam_quiz",
          action: "auto",
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(p.count()).toBe(0);
});
it("repeat receipt checks preserve the original action safety evidence", async () => {
  const f = await setup(),
    p = provider();
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  const before = await db.automationDecision.findUniqueOrThrow({
    where: { reviewId: f.id },
  });
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  expect(
    (
      await db.automationDecision.findUniqueOrThrow({
        where: { reviewId: f.id },
      })
    ).evidence,
  ).toEqual(before.evidence);
});
it("activity explains the qualifying category, source and safety checks", async () => {
  const f = await setup(),
    p = provider();
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  const { listActivity } =
    await import("../../apps/api/src/application/automation/activity.js");
  const activity = await listActivity(f.actor);
  expect(activity.items[0].explanation).toContain("Exam / quiz");
  expect(activity.items[0].explanation).toContain("Gmail");
  expect(activity.items[0].explanation).toContain(
    "duplicate and conflict checks",
  );
});
it("a corrupted local receipt cannot be presented as confirmed automatic success", async () => {
  const f = await setup(),
    p = provider();
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  await db.calendarEvent.update({
    where: { reviewItemId: f.id },
    data: {
      receipt: {
        providerEventId: "wrong",
        calendarId: "primary",
        payloadHash: "wrong",
        htmlLink: "https://calendar.google.com/calendar/event?eid=synthetic",
      },
    },
  });
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("record_problem");
  expect(p.count()).toBe(1);
});
it("concurrent first policy reads initialize one disabled policy without request failures", async () => {
  const f = await fixture();
  const policies = await Promise.all(
    Array.from({ length: 20 }, () => getPolicy(f.actor)),
  );
  expect(
    policies.every(
      (p) => p.revision === 1 && !p.enabled && p.enabledAt === null,
    ),
  ).toBe(true);
  expect(
    await db.automationPolicy.count({ where: { userId: f.user.id } }),
  ).toBe(1);
});
it("first-load policy initialization survives independently delayed database inserts", async () => {
  const f = await fixture(),
    name = "policy_init_" + crypto.randomUUID().replaceAll("-", "");
  await db.$executeRawUnsafe(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."userId"='${f.user.id}'::uuid THEN PERFORM pg_sleep(0.1); END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE INSERT ON "AutomationPolicy" FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  try {
    const reads = await Promise.allSettled(
      Array.from({ length: 8 }, () => getPolicy(f.actor)),
    );
    expect(reads.every((r) => r.status === "fulfilled")).toBe(true);
    expect(
      await db.automationPolicy.count({ where: { userId: f.user.id } }),
    ).toBe(1);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON "AutomationPolicy"`);
    await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
  }
});
it("decision evidence never invents an applicable rule for an untrusted source", async () => {
  const f = await setup(),
    p = provider();
  const policy = await getPolicy(f.actor);
  await savePolicy(f.actor, policy.revision, {
    enabled: true,
    pollGmail: false,
    rules: [],
  });
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  const row = await db.automationDecision.findUniqueOrThrow({
    where: { reviewId: f.id },
  });
  expect((row.evidence as { rule: unknown }).rule).toBeNull();
});
it("erased source evidence requires confirmation before a new automatic action", async () => {
  const f = await setup(),
    p = provider();
  const { deleteContent } =
    await import("../../apps/api/src/infrastructure/persistence/retention.js");
  await deleteContent(f.user.id, f.message.id);
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("facts_confirmation");
  expect(p.count()).toBe(0);
});
