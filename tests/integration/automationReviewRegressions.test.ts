import { it, expect, afterAll } from "vitest";
import { setup, provider } from "./automationHelpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import { evaluateReview } from "../../apps/api/src/application/automation/engine.js";
import { answerQuestion } from "../../apps/api/src/application/automation/questions.js";
import {
  getPolicy,
  savePolicy,
} from "../../apps/api/src/application/automation/policyStore.js";
import { AppError } from "@hub/contracts";
afterAll(() => db.$disconnect());
it.each(["policy", "source"] as const)(
  "does not revive old duplicate permission after a %s revision",
  async (kind) => {
    const f = await setup(),
      p = provider();
    const draft = (await getReview(f.actor, f.id)).draft;
    p.gateway.list = async () => ({
      events: [
        {
          key: "other",
          source: "google",
          title: draft.title,
          location: null,
          temporal: draft.temporal,
        },
      ],
      coverage: { status: "checked" },
    });
    await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
    const q = await db.automationQuestion.findFirstOrThrow({
      where: { userId: f.actor.userId, status: "open" },
    });
    const goodGet = p.gateway.get;
    p.gateway.get = async () => {
      throw new AppError("provider_unavailable", 503);
    };
    expect(
      (
        await answerQuestion(
          f.actor,
          q.id,
          {
            expectedRevision: q.reviewRevision,
            answer: { kind: "confirm", value: true },
          },
          p.gateway,
          { allowWrites: true },
        )
      ).reason,
    ).toBe("action_unknown");
    expect(p.count()).toBe(0);
    if (kind === "policy") {
      const policy = await getPolicy(f.actor);
      await savePolicy(f.actor, policy.revision, {
        enabled: true,
        pollGmail: false,
        rules: policy.rules.map((r) => ({ ...r, action: "ask" as const })),
      });
    } else {
      await db.automationDecision.update({
        where: { reviewId: f.id },
        data: { sourceRevision: 2 },
      });
    }
    p.gateway.get = goodGet;
    expect(
      (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
        .reason,
    ).toBe("possible_duplicate");
    const second = await evaluateReview(f.actor, f.id, p.gateway, {
      allowWrites: true,
    });
    expect(p.count()).toBe(0);
    const decision = await db.automationDecision.findUniqueOrThrow({
      where: { reviewId: f.id },
    });
    expect(decision.confirmedFields).toEqual([]);
    expect(decision.confirmedRevision).toBeNull();
    expect(decision.duplicateFingerprint).toBeNull();
  },
);
it.each(["same", "mismatch", "unrelated"] as const)(
  "lost-response recovery with provider-visible %s event keeps identity guards",
  async (mode) => {
    const f = await setup(),
      p = provider();
    p.lose();
    expect(
      (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
        .reason,
    ).toBe("action_unknown");
    const draft = (await getReview(f.actor, f.id)).approvedSnapshot!;
    const write = await db.calendarEvent.findUniqueOrThrow({
      where: { reviewItemId: f.id },
    });
    p.gateway.list = async () => ({
      events: [
        {
          key: "google:" + write.providerEventId,
          source: "google",
          title: draft.title,
          location: draft.location,
          temporal: draft.temporal,
          providerEventId: write.providerEventId,
          calendarId: "primary",
          availability: "busy",
        },
        ...(mode === "unrelated"
          ? [
              {
                key: "unrelated",
                source: "google" as const,
                title: draft.title,
                location: draft.location,
                temporal: draft.temporal,
                providerEventId: "unrelated-id",
                calendarId: "primary" as const,
                payloadHash: write.payloadHash,
                availability: "busy" as const,
              },
            ]
          : []),
      ],
      coverage: { status: "checked" },
    });
    if (mode === "mismatch")
      p.gateway.get = async () => ({
        providerEventId: write.providerEventId,
        calendarId: "primary",
        payloadHash: "mismatch",
        htmlLink: "https://calendar.google.com/calendar/u/0/r",
      });
    const recovered = await evaluateReview(f.actor, f.id, p.gateway, {
      allowWrites: true,
    });
    expect(recovered.reason).toBe(
      mode === "same"
        ? "added"
        : mode === "mismatch"
          ? "action_failed"
          : "possible_duplicate",
    );
    expect(p.count()).toBe(1);
  },
);
it.each(["first", "reenroll"] as const)(
  "starts %s Gmail polling opt-in at that collection boundary",
  async (mode) => {
    const { AutomationScheduler } =
      await import("../../apps/api/src/application/automation/scheduler.js");
    const f = await setup(),
      p = provider();
    const oldOptIn = new Date(Date.now() - 86400000);
    await db.automationPolicy.update({
      where: { userId: f.actor.userId },
      data: { enabledAt: oldOptIn },
    });
    if (mode === "reenroll") {
      const first = await getPolicy(f.actor);
      await savePolicy(f.actor, first.revision, {
        enabled: true,
        pollGmail: true,
        rules: first.rules,
      });
      await db.ingestionPoll.create({
        data: {
          connectionId: f.connection.id,
          userId: f.user.id,
          watermark: oldOptIn,
          windowEnd: new Date(oldOptIn.valueOf() + 3600000),
          pageToken: "old-page",
          pendingIds: ["old-message"],
        },
      });
      const on = await getPolicy(f.actor);
      await savePolicy(f.actor, on.revision, {
        enabled: true,
        pollGmail: false,
        rules: on.rules,
      });
    }
    const policy = await getPolicy(f.actor),
      pollOptIn = new Date();
    await savePolicy(f.actor, policy.revision, {
      enabled: true,
      pollGmail: true,
      rules: policy.rules,
    });
    const windows: { after: string; before: string }[] = [];
    const fetched: string[] = [];
    const scheduler = new AutomationScheduler({
      gmail: {
        list: async () => ({ messages: [] }),
        get: async (_a, id) => {
          fetched.push(id);
          throw Error("unused");
        },
        poll: async (_actor, w) => {
          windows.push(w);
          return { ids: [] };
        },
      },
      calendar: p.gateway,
      allowWrites: false,
      now: () => new Date(Date.now() + 1000),
    });
    await scheduler.tick(f.actor);
    expect(fetched).toEqual([]);
    expect(windows).toHaveLength(1);
    expect(Date.parse(windows[0].after)).toBeGreaterThanOrEqual(
      pollOptIn.valueOf(),
    );
  },
);
it.each(["idle", "active"] as const)(
  "handles %s lock connection loss safely and reconnects",
  async (mode) => {
    const { fork } = await import("node:child_process");
    const appName =
      "phase5_test_idle_" + crypto.randomUUID().replaceAll("-", "");
    const child = fork(
      new URL("./automationIdlePoolWorker.ts", import.meta.url),
      [mode],
      {
        execArgv: ["--import", "tsx"],
        env: {
          PATH: process.env.PATH,
          TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
          PGAPPNAME: appName,
          NODE_ENV: "test",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr!.on("data", (d) => {
      stderr += d;
    });
    const exit = new Promise((resolve) => child.on("exit", resolve));
    const messages: unknown[] = [];
    child.on("message", (m) => messages.push(m));
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
    });
    await db.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=${appName} AND datname=current_database()`;
    if (mode === "active") child.send("continue");
    const code = await exit;
    expect(code).toBe(0);
    expect(messages).toContain("reacquired");
    if (mode === "active") expect(messages).toContain("blocked");
    expect(messages).not.toContain("unsafe");
    expect(stderr.includes("Unhandled 'error' event")).toBe(false);
  },
);
