import { it, expect, afterAll } from "vitest";
import { fork } from "node:child_process";
import { resolve } from "node:path";
import { setup, provider } from "./automationHelpers.js";
import { fixture } from "./helpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { withActionLock } from "../../apps/api/src/application/automation/actionLock.js";
import { evaluateReview } from "../../apps/api/src/application/automation/engine.js";
import { approveReview } from "../../apps/api/src/application/approveReview.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import { createCalendarEvent } from "../../apps/api/src/application/createCalendarEvent.js";
import {
  getPolicy,
  savePolicy,
} from "../../apps/api/src/application/automation/policyStore.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import { normalizeOutlook } from "../../apps/api/src/infrastructure/microsoft/normalize.js";
import { connectRelay } from "../../apps/api/src/infrastructure/discord/connections.js";
import { ingestDiscord } from "../../apps/api/src/application/discordIngestion.js";
import { answerQuestion } from "../../apps/api/src/application/automation/questions.js";
afterAll(() => db.$disconnect());
async function until(test: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Bounded stress condition did not complete");
}
it("a separate process waits for the workspace action lock and proceeds after release", async () => {
  const f = await fixture();
  const name = "phase5_worker_" + crypto.randomUUID().replaceAll("-", "");
  const phases = new Set<string>();
  let child: ReturnType<typeof fork> | undefined;
  try {
    await withActionLock(f.actor, async () => {
      child = fork(
        resolve("tests/integration/automationLockWorker.ts"),
        [f.user.id],
        {
          execArgv: ["--import", "tsx"],
          env: {
            PATH: process.env.PATH,
            TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
            NODE_ENV: "test",
            PGAPPNAME: name,
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      child.on("message", (message) => {
        if (message && typeof message === "object" && "type" in message)
          phases.add(String(message.type));
      });
      await until(() => phases.has("ready"));
      await until(async () => {
        const waits = await db.$queryRaw<
          Array<{ wait_event: string | null }>
        >`SELECT wait_event FROM pg_stat_activity WHERE application_name=${name} AND datname=current_database()`;
        return waits.some((w) => w.wait_event === "advisory");
      });
      expect(phases.has("locked")).toBe(false);
    });
    await until(() => phases.has("locked"));
    child!.send("release");
    await until(() => phases.has("done"));
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
  }
}, 15000);
it("manual approval during automatic evaluation invalidates the stale decision and writes once", async () => {
  const f = await setup(),
    p = provider();
  let release!: () => void, started!: () => void;
  const reading = new Promise<void>((r) => (started = r)),
    pending = new Promise<void>((r) => (release = r));
  p.gateway.list = async () => {
    started();
    await pending;
    return { events: [], coverage: { status: "checked" } };
  };
  const automatic = evaluateReview(f.actor, f.id, p.gateway, {
    allowWrites: true,
  });
  await reading;
  const r = await getReview(f.actor, f.id);
  await approveReview(f.actor, f.id, r.revision);
  const manual = createCalendarEvent(f.actor, f.id, p.gateway);
  release();
  expect((await automatic).reason).toBe("stale");
  expect((await manual).status).toBe("added");
  expect(p.count()).toBe(1);
});
it("Gmail, Outlook normalization and Follow-shaped Discord share real-world duplicate advisories", async () => {
  const f = await setup(true, { subject: "Shared Exam" }),
    p = provider();
  const authorization = await db.microsoftAuthorization.create({
    data: {
      userId: f.user.id,
      tenantId: crypto.randomUUID(),
      accountId: "synthetic",
      scopes: [],
    },
  });
  const outlook = await db.sourceConnection.create({
    data: {
      userId: f.user.id,
      provider: "outlook",
      microsoftAuthorizationId: authorization.id,
      externalAccountId: "synthetic",
    },
  });
  const message = normalizeOutlook(
    {
      id: "AAMkSyntheticShared",
      subject: "Shared Exam",
      receivedDateTime: new Date().toISOString(),
      body: {
        contentType: "text",
        content: "Exam October 20, 2026 at 2:00 PM to 3:00 PM America/Chicago",
      },
    },
    {
      id: crypto.randomUUID(),
      userId: f.user.id,
      sourceConnectionId: outlook.id,
      ingestedAt: new Date().toISOString(),
    },
  );
  const saved = await saveProcessedMessage(
    f.actor,
    message,
    processMessage(message, "America/Chicago"),
  );
  if (!saved.reviewId) throw Error("Synthetic Outlook review missing");
  const config = {
    token: "synthetic-token-not-real",
    guildId: String(
      800000000000000000n +
        BigInt("0x" + crypto.randomUUID().replaceAll("-", "").slice(0, 14)),
    ),
    channelIds: ["800000000000001001"],
  };
  const binding = await connectRelay(f.actor, config);
  const policy = await getPolicy(f.actor);
  await savePolicy(f.actor, policy.revision, {
    enabled: true,
    pollGmail: false,
    rules: [
      ...policy.rules,
      { connectionId: outlook.id, category: "exam_quiz", action: "auto" },
      {
        connectionId: binding.sourceConnectionId,
        category: "exam_quiz",
        action: "auto",
      },
    ],
  });
  const post = {
    id: "800000000000002001",
    guild_id: config.guildId,
    channel_id: config.channelIds[0],
    type: 0,
    flags: 2,
    webhook_id: "800000000000003001",
    message_reference: {
      guild_id: "800000000000004001",
      channel_id: "800000000000004002",
      message_id: "800000000000004003",
    },
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    content: "Exam October 20, 2026 at 2:00 PM to 3:00 PM America/Chicago",
    embeds: [],
  };
  const discord = await ingestDiscord(config, post, binding.generation);
  if (!("reviewId" in discord) || !discord.reviewId)
    throw Error("Synthetic Discord review missing");
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("possible_duplicate");
  expect(
    (
      await evaluateReview(f.actor, saved.reviewId, p.gateway, {
        allowWrites: true,
      })
    ).reason,
  ).toBe("possible_duplicate");
  await evaluateReview(f.actor, discord.reviewId, p.gateway, {
    allowWrites: true,
  });
  const q = await db.automationQuestion.findFirstOrThrow({
    where: { decision: { reviewId: discord.reviewId }, status: "open" },
  });
  expect(q.kind).toBe("title");
  expect(
    (
      await answerQuestion(
        f.actor,
        q.id,
        {
          expectedRevision: q.reviewRevision,
          answer: { kind: "title", value: "Shared Exam" },
        },
        p.gateway,
        { allowWrites: true },
      )
    ).reason,
  ).toBe("possible_duplicate");
  expect(p.count()).toBe(0);
});
it("erasure committed during provider checks cannot authorize an automatic write", async () => {
  const f = await setup(),
    p = provider();
  const { deleteContent } =
    await import("../../apps/api/src/infrastructure/persistence/retention.js");
  p.gateway.list = async () => {
    await deleteContent(f.user.id, f.message.id);
    return { events: [], coverage: { status: "checked" } };
  };
  expect(
    (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
      .reason,
  ).toBe("facts_confirmation");
  expect(p.count()).toBe(0);
});
it("erasure after eligibility persistence is fenced before automatic approval", async () => {
  const f = await setup(),
    p = provider(),
    name = "source_erase_" + crypto.randomUUID().replaceAll("-", "");
  await db.$executeRawUnsafe(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."messageId"='${f.message.id}'::uuid AND NEW.reason='eligible' THEN UPDATE "NormalizedMessage" SET content=NULL WHERE id=NEW."messageId"; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON "AutomationDecision" FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  try {
    expect(
      (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
        .reason,
    ).toBe("stale");
    expect(p.count()).toBe(0);
    expect(
      (await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true }))
        .reason,
    ).toBe("facts_confirmation");
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON "AutomationDecision"`);
    await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
  }
});
it.each(["not-a-date", "2099-01-01T00:00:00.000Z"])(
  "invalid or future eligibility proof %s cannot approve",
  async (checkedAt) => {
    const f = await setup(),
      p = provider();
    await evaluateReview(f.actor, f.id, p.gateway);
    const row = await db.automationDecision.findUniqueOrThrow({
      where: { reviewId: f.id },
    });
    await db.automationDecision.update({
      where: { id: row.id },
      data: {
        decision: "auto_handle",
        reason: "eligible",
        evidence: {
          ...(row.evidence as Record<string, unknown>),
          checkedAt,
        } as any,
      },
    });
    const { approveAutomatically } =
      await import("../../apps/api/src/application/approveReview.js");
    let code = "none";
    try {
      await withActionLock(f.actor, () =>
        approveAutomatically(f.actor, f.id, 1, {
          decisionId: row.id,
          policyRevision: row.policyRevision,
        }),
      );
    } catch (error) {
      code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "unexpected";
    }
    expect(code).toBe("stale_review");
    expect(p.count()).toBe(0);
  },
);
