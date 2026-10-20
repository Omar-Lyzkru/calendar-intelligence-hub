import { it, expect, afterAll } from "vitest";
import { fixture } from "./helpers.js";
import { provider } from "./automationHelpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import {
  getPolicy,
  savePolicy,
} from "../../apps/api/src/application/automation/policyStore.js";
import { AutomationScheduler } from "../../apps/api/src/application/automation/scheduler.js";
import type { GmailGateway } from "../../apps/api/src/infrastructure/google/gmail.js";
import { AppError } from "@hub/contracts";
afterAll(() => db.$disconnect());
function payload(id: string) {
  return {
    id,
    internalDate: String(Date.now()),
    payload: {
      mimeType: "text/plain",
      headers: [
        {
          name: "Subject",
          value:
            id === "newsletter" ? "Department newsletter" : "Synthetic Exam",
        },
      ],
      body: {
        data: Buffer.from(
          id === "newsletter"
            ? "Department newsletter with general information"
            : "Exam October 20, 2026 at 2:00 PM to 3:00 PM America/Chicago",
        ).toString("base64url"),
      },
    },
  };
}
async function setup() {
  const f = await fixture();
  const policy = await getPolicy(f.actor);
  await savePolicy(f.actor, policy.revision, {
    enabled: true,
    pollGmail: true,
    rules: [
      { connectionId: f.connection.id, category: "exam_quiz", action: "auto" },
    ],
  });
  const clock = { now: new Date(Date.now() + 120000) };
  const polls: Array<{ after: string; before: string; pageToken?: string }> =
      [],
    gets: string[] = [];
  const gmail: GmailGateway = {
    list: async () => ({ messages: [] }),
    get: async (_a, id) => {
      gets.push(id);
      return payload(id);
    },
    poll: async (_a, w) => {
      polls.push(w);
      return { ids: ["same"] };
    },
  };
  const p = provider();
  const make = () =>
    new AutomationScheduler({
      gmail,
      calendar: p.gateway,
      allowWrites: true,
      now: () => clock.now,
    });
  return { ...f, clock, polls, gets, gmail, p, make };
}
it("poll starts at opt-in, imports a bounded page and shares the automatic writer", async () => {
  const f = await setup();
  await f.make().tick(f.actor);
  expect(f.polls).toHaveLength(1);
  const policy = await getPolicy(f.actor);
  expect(new Date(f.polls[0].after).valueOf()).toBe(
    policy.enabledAt!.valueOf(),
  );
  expect(
    new Date(f.polls[0].before).valueOf() -
      new Date(f.polls[0].after).valueOf(),
  ).toBeLessThanOrEqual(3600000);
  expect(f.p.count()).toBe(1);
  expect(f.gets).toEqual(["same"]);
});
it("repeated polls and a new scheduler instance do not fetch or create the same source again", async () => {
  const f = await setup();
  await f.make().tick(f.actor);
  f.clock.now = new Date(f.clock.now.valueOf() + 120000);
  await f.make().tick(f.actor);
  expect(f.gets).toEqual(["same"]);
  expect(f.p.count()).toBe(1);
  expect(
    await db.normalizedMessage.count({
      where: { sourceConnectionId: f.connection.id },
    }),
  ).toBe(1);
});
it("overlapping scheduler instances claim one provider window", async () => {
  const f = await setup();
  await Promise.all([f.make().tick(f.actor), f.make().tick(f.actor)]);
  expect(f.polls).toHaveLength(1);
  expect(f.gets).toEqual(["same"]);
  expect(f.p.count()).toBe(1);
});
it("pagination persists a fixed window and reads at most one page per tick", async () => {
  const f = await setup();
  f.gmail.poll = async (_a, w) => {
    f.polls.push(w);
    return {
      ids: ["same"],
      nextPageToken: w.pageToken ? undefined : "next-page",
    };
  };
  await f.make().tick(f.actor);
  const state = await db.ingestionPoll.findUniqueOrThrow({
    where: { connectionId: f.connection.id },
  });
  expect(state.pageToken).toBe("next-page");
  expect(f.polls).toHaveLength(1);
  f.clock.now = new Date(state.nextRunAt.valueOf() + 1);
  await f.make().tick(f.actor);
  expect(f.polls[1]).toEqual({ ...f.polls[0], pageToken: "next-page" });
  expect(f.p.count()).toBe(1);
});
it("partial fetch failure retains pending IDs and does not advance the watermark", async () => {
  const f = await setup();
  let failed = true;
  f.gmail.poll = async (_a, w) => {
    f.polls.push(w);
    return { ids: ["same", "bad", "later"] };
  };
  f.gmail.get = async (_a, id) => {
    f.gets.push(id);
    if (id === "bad" && failed)
      throw new AppError("gmail_fetch_unavailable", 503);
    return payload(id);
  };
  await f.make().tick(f.actor);
  const state = await db.ingestionPoll.findUniqueOrThrow({
    where: { connectionId: f.connection.id },
  });
  expect(state.pendingIds).toEqual(["bad", "later"]);
  expect(state.watermark.toISOString()).toBe(f.polls[0].after);
  expect(state.status).toBe("retry");
  failed = false;
  f.clock.now = new Date(state.nextRunAt.valueOf() + 1);
  await f.make().tick(f.actor);
  expect(f.polls).toHaveLength(1);
  expect(f.gets.filter((id) => id === "same")).toHaveLength(1);
  expect(
    (
      await db.ingestionPoll.findUniqueOrThrow({
        where: { connectionId: f.connection.id },
      })
    ).pendingIds,
  ).toEqual([]);
});
it.each([
  "provider_rate_limited",
  "reauthorization_required",
  "gmail_list_unavailable",
])("%s remains a visible problem with backoff", async (code) => {
  const f = await setup();
  f.gmail.poll = async () => {
    throw new AppError(code, 503);
  };
  await f.make().tick(f.actor);
  const state = await db.ingestionPoll.findUniqueOrThrow({
    where: { connectionId: f.connection.id },
  });
  expect(["retry", "blocked"]).toContain(state.status);
  expect(state.failures).toBe(1);
  expect(state.nextRunAt.valueOf()).toBeGreaterThan(f.clock.now.valueOf());
  expect(f.gets).toEqual([]);
  expect(f.p.count()).toBe(0);
  await f.make().tick(f.actor);
  expect(
    (
      await db.ingestionPoll.findUniqueOrThrow({
        where: { connectionId: f.connection.id },
      })
    ).failures,
  ).toBe(1);
});
it("disabled polling does not read providers and never activates Outlook polling", async () => {
  const f = await setup();
  const policy = await getPolicy(f.actor);
  await savePolicy(f.actor, policy.revision, {
    enabled: true,
    pollGmail: false,
    rules: policy.rules,
  });
  await f.make().tick(f.actor);
  expect(f.polls).toEqual([]);
  expect(f.gets).toEqual([]);
});
it("no-event source creates a domain skip rather than a processing failure", async () => {
  const f = await setup();
  f.gmail.poll = async () => ({ ids: ["newsletter"] });
  await f.make().tick(f.actor);
  expect(
    await db.automationDecision.findFirst({ where: { userId: f.user.id } }),
  ).toMatchObject({ decision: "skip", reason: "no_event" });
  expect(f.p.count()).toBe(0);
});
it("stop prevents subsequent reads or automatic actions", async () => {
  const f = await setup(),
    scheduler = f.make();
  await scheduler.stop();
  await scheduler.tick(f.actor);
  expect(f.polls).toEqual([]);
  expect(f.p.count()).toBe(0);
});
it("oversized provider ID page fails closed rather than scanning unlimited history", async () => {
  const f = await setup();
  f.gmail.poll = async () => ({
    ids: Array.from({ length: 21 }, (_, i) => "id" + i),
  });
  await f.make().tick(f.actor);
  expect(f.gets).toEqual([]);
  expect(
    (
      await db.ingestionPoll.findUniqueOrThrow({
        where: { connectionId: f.connection.id },
      })
    ).status,
  ).toBe("retry");
});
it("exhausted failures pause imports until explicit retry", async () => {
  const f = await setup();
  f.gmail.poll = async () => {
    throw new AppError("gmail_list_unavailable", 503);
  };
  for (let i = 0; i < 5; i++) {
    await f.make().tick(f.actor);
    const s = await db.ingestionPoll.findUniqueOrThrow({
      where: { connectionId: f.connection.id },
    });
    f.clock.now = new Date(s.nextRunAt.valueOf() + 1);
  }
  expect(
    (
      await db.ingestionPoll.findUniqueOrThrow({
        where: { connectionId: f.connection.id },
      })
    ).status,
  ).toBe("blocked");
  f.gmail.poll = async () => ({ ids: ["same"] });
  await f.make().tick(f.actor);
  expect(f.gets).toEqual([]);
});
it("one hundred source replays retain one normalized message and one Calendar event", async () => {
  const f = await setup();
  for (let i = 0; i < 100; i++) {
    await f.make().tick(f.actor);
    f.clock.now = new Date(f.clock.now.valueOf() + 120000);
  }
  expect(f.gets).toEqual(["same"]);
  expect(f.p.count()).toBe(1);
  expect(
    await db.normalizedMessage.count({
      where: { sourceConnectionId: f.connection.id },
    }),
  ).toBe(1);
}, 30000);
it("missing review state is a visible problem and cannot masquerade as no-event", async () => {
  const f = await setup();
  await f.make().tick(f.actor);
  const review = await db.reviewItem.findFirstOrThrow({
    where: { userId: f.user.id },
  });
  await db.automationDecision.deleteMany({ where: { reviewId: review.id } });
  await db.reviewItem.delete({ where: { id: review.id } });
  f.clock.now = new Date(f.clock.now.valueOf() + 120000);
  await f.make().tick(f.actor);
  expect(
    await db.automationDecision.findFirst({ where: { userId: f.user.id } }),
  ).toMatchObject({ decision: "blocked", reason: "record_problem" });
});
it("shutdown discards a source body finishing after stop and does not begin automatic action", async () => {
  const f = await setup(),
    scheduler = f.make();
  let release!: () => void, started!: () => void;
  const reading = new Promise<void>((r) => (started = r)),
    pending = new Promise<void>((r) => (release = r));
  f.gmail.get = async (_a, id) => {
    started();
    await pending;
    return payload(id);
  };
  const running = scheduler.tick(f.actor);
  await reading;
  const stopping = scheduler.stop();
  release();
  await Promise.all([running, stopping]);
  expect(
    await db.normalizedMessage.count({
      where: { sourceConnectionId: f.connection.id },
    }),
  ).toBe(0);
  expect(f.p.count()).toBe(0);
});
