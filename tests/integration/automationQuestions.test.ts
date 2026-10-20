import { it, expect, afterAll } from "vitest";
import { setup, provider } from "./automationHelpers.js";
import { fixture } from "./helpers.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { evaluateReview } from "../../apps/api/src/application/automation/engine.js";
import { answerQuestion } from "../../apps/api/src/application/automation/questions.js";
import { listActivity } from "../../apps/api/src/application/automation/activity.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import { saveReview } from "../../apps/api/src/application/approveReview.js";
import {
  getPolicy,
  savePolicy,
} from "../../apps/api/src/application/automation/policyStore.js";
afterAll(() => db.$disconnect());
async function question(
  f: Awaited<ReturnType<typeof setup>>,
  p: ReturnType<typeof provider>,
) {
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  return db.automationQuestion.findFirstOrThrow({
    where: { userId: f.user.id, status: "open" },
  });
}
it("missing title asks only for title and its answer resumes safe creation", async () => {
  const f = await setup(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, { ...r.draft, title: "" });
  const q = await question(f, p);
  expect(q.kind).toBe("title");
  expect(
    (
      await answerQuestion(
        f.actor,
        q.id,
        {
          expectedRevision: q.reviewRevision,
          answer: { kind: "title", value: "User chosen exam" },
        },
        p.gateway,
        { allowWrites: true },
      )
    ).reason,
  ).toBe("added");
  expect(p.count()).toBe(1);
});
it("missing date answer preserves uncertainty and asks the next necessary time question", async () => {
  const f = await setup(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, {
    ...r.draft,
    temporal: {
      kind: "unresolved",
      text: "PRIVATE_QUESTION_SENTINEL",
      timezone: "America/Chicago",
      timezoneProvenance: "assumed",
    },
  });
  const q = await question(f, p);
  expect(q.kind).toBe("date");
  const result = await answerQuestion(
    f.actor,
    q.id,
    {
      expectedRevision: q.reviewRevision,
      answer: { kind: "date", value: "2026-10-22" },
    },
    p.gateway,
    { allowWrites: true },
  );
  expect(result.decision).toBe("ask_user");
  expect(p.count()).toBe(0);
  const next = await db.automationQuestion.findFirstOrThrow({
    where: { userId: f.user.id, status: "open" },
  });
  expect(["time", "all_day"]).toContain(next.kind);
});
it("explicit interval answer resolves missing time without optional information", async () => {
  const f = await setup(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, {
    ...r.draft,
    temporal: {
      kind: "unresolved",
      text: "",
      timezone: "America/Chicago",
      partial: { year: 2026, month: 10, day: 22 },
    },
  });
  const q = await question(f, p);
  expect(q.kind).toBe("time");
  expect(
    (
      await answerQuestion(
        f.actor,
        q.id,
        {
          expectedRevision: q.reviewRevision,
          answer: {
            kind: "temporal",
            value: {
              kind: "timed",
              start: "2026-10-22T19:00:00.000Z",
              end: "2026-10-22T20:00:00.000Z",
              timezone: "America/Chicago",
            },
          },
        },
        p.gateway,
        { allowWrites: true },
      )
    ).reason,
  ).toBe("added");
  expect(p.count()).toBe(1);
});
it("stale question cannot apply after candidate edit", async () => {
  const f = await setup(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, { ...r.draft, title: "" });
  const q = await question(f, p);
  const current = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, current.revision, {
    ...current.draft,
    title: "Another tab",
  });
  await expect(
    answerQuestion(
      f.actor,
      q.id,
      {
        expectedRevision: q.reviewRevision,
        answer: { kind: "title", value: "stale" },
      },
      p.gateway,
      { allowWrites: true },
    ),
  ).rejects.toMatchObject({ code: "stale_review" });
  expect(p.count()).toBe(0);
});
it("policy changes invalidate questions and never authorize an old answer", async () => {
  const f = await setup(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, { ...r.draft, title: "" });
  const q = await question(f, p);
  const policy = await getPolicy(f.actor);
  await savePolicy(f.actor, policy.revision, {
    enabled: false,
    pollGmail: false,
    rules: policy.rules,
  });
  await expect(
    answerQuestion(
      f.actor,
      q.id,
      {
        expectedRevision: q.reviewRevision,
        answer: { kind: "title", value: "Exam" },
      },
      p.gateway,
      { allowWrites: true },
    ),
  ).rejects.toMatchObject({ code: "stale_review" });
  expect(p.count()).toBe(0);
});
it("question answers are owner protected", async () => {
  const f = await setup(),
    other = await fixture(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, { ...r.draft, title: "" });
  const q = await question(f, p);
  await expect(
    answerQuestion(
      other.actor,
      q.id,
      {
        expectedRevision: q.reviewRevision,
        answer: { kind: "title", value: "foreign" },
      },
      p.gateway,
      { allowWrites: true },
    ),
  ).rejects.toMatchObject({ code: "not_found" });
});
it("question cannot accept unrelated fields or answer twice", async () => {
  const f = await setup(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, { ...r.draft, title: "" });
  const q = await question(f, p);
  await expect(
    answerQuestion(
      f.actor,
      q.id,
      {
        expectedRevision: q.reviewRevision,
        answer: {
          kind: "title",
          value: "Exam",
          description: "smuggled",
        } as any,
      },
      p.gateway,
      { allowWrites: true },
    ),
  ).rejects.toThrow();
  await answerQuestion(
    f.actor,
    q.id,
    {
      expectedRevision: q.reviewRevision,
      answer: { kind: "title", value: "Exam" },
    },
    p.gateway,
    { allowWrites: true },
  );
  await expect(
    answerQuestion(
      f.actor,
      q.id,
      {
        expectedRevision: q.reviewRevision,
        answer: { kind: "title", value: "Exam" },
      },
      p.gateway,
      { allowWrites: true },
    ),
  ).rejects.toMatchObject({ code: "stale_review" });
  expect(p.count()).toBe(1);
});
it("activity projection never includes private source text or unresolved original text", async () => {
  const f = await setup(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, {
    ...r.draft,
    temporal: {
      kind: "unresolved",
      text: "PRIVATE_QUESTION_SENTINEL",
      timezone: "America/Chicago",
    },
  });
  await question(f, p);
  const activity = await listActivity(f.actor);
  expect(activity.items[0].question?.kind).toBe("date");
  expect(JSON.stringify(activity)).not.toContain("PRIVATE_SOURCE_SENTINEL");
  expect(JSON.stringify(activity)).not.toContain("PRIVATE_QUESTION_SENTINEL");
});
it("duplicate confirmation must match fresh advisory evidence", async () => {
  const f = await setup(),
    p = provider();
  let title = "Synthetic Exam";
  p.gateway.list = async () => ({
    events: [
      {
        key: "synthetic-match",
        source: "google",
        title,
        location: null,
        temporal: (await getReview(f.actor, f.id)).draft.temporal,
      },
    ],
    coverage: { status: "checked" },
  });
  const q = await question(f, p);
  expect(q.kind).toBe("duplicate");
  title = "Synthetic Exam updated";
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
  ).toBe("possible_duplicate");
  expect(p.count()).toBe(0);
});
it("fresh duplicate confirmation permits one explicit action", async () => {
  const f = await setup(),
    p = provider();
  p.gateway.list = async () => ({
    events: [
      {
        key: "synthetic-match",
        source: "google",
        title: "Synthetic Exam",
        location: null,
        temporal: (await getReview(f.actor, f.id)).draft.temporal,
      },
    ],
    coverage: { status: "checked" },
  });
  const q = await question(f, p);
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
  ).toBe("added");
  expect(p.count()).toBe(1);
});
it("conflict confirmation is a separate focused decision", async () => {
  const f = await setup(),
    p = provider();
  p.gateway.list = async () => ({
    events: [
      {
        key: "different",
        source: "google",
        title: "Dentist",
        location: null,
        temporal: (await getReview(f.actor, f.id)).draft.temporal,
        availability: "busy",
      },
    ],
    coverage: { status: "checked" },
  });
  const q = await question(f, p);
  expect(q.kind).toBe("conflict");
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
  ).toBe("added");
  expect(p.count()).toBe(1);
});
it("explicit skip is a domain outcome rather than a technical problem", async () => {
  const f = await setup(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, { ...r.draft, title: "" });
  const q = await question(f, p);
  expect(
    (
      await answerQuestion(
        f.actor,
        q.id,
        { expectedRevision: q.reviewRevision, answer: { kind: "skip" } },
        p.gateway,
        { allowWrites: true },
      )
    ).decision,
  ).toBe("skip");
  expect(p.count()).toBe(0);
});
it("duplicate question supplies only necessary commitment context", async () => {
  const f = await setup(),
    p = provider();
  p.gateway.list = async () => ({
    events: [
      {
        key: "synthetic-match",
        source: "google",
        title: "Synthetic Exam",
        location: null,
        temporal: (await getReview(f.actor, f.id)).draft.temporal,
      },
    ],
    coverage: { status: "checked" },
  });
  await question(f, p);
  const activity = await listActivity(f.actor);
  expect(activity.items[0].question?.matches?.[0].title).toBe("Synthetic Exam");
  expect(JSON.stringify(activity)).not.toContain("PRIVATE_SOURCE_SENTINEL");
});
it("a Discord source revision invalidates an unanswered question", async () => {
  const f = await setup(),
    p = provider();
  const { connectRelay } =
    await import("../../apps/api/src/infrastructure/discord/connections.js");
  const { ingestDiscord, recordDiscordChange } =
    await import("../../apps/api/src/application/discordIngestion.js");
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
  const saved = await ingestDiscord(config, post, binding.generation);
  if (!("reviewId" in saved) || !saved.reviewId)
    throw Error("synthetic review missing");
  await evaluateReview(f.actor, saved.reviewId, p.gateway, {
    allowWrites: true,
  });
  const q = await db.automationQuestion.findFirstOrThrow({
    where: { userId: f.user.id, status: "open" },
  });
  await recordDiscordChange(
    config,
    {
      kind: "update",
      payload: {
        ...post,
        content: post.content + " changed",
        edited_timestamp: new Date().toISOString(),
      },
    },
    binding.generation,
  );
  await expect(
    answerQuestion(
      f.actor,
      q.id,
      {
        expectedRevision: q.reviewRevision,
        answer: { kind: "title", value: "Stale exam" },
      },
      p.gateway,
      { allowWrites: true },
    ),
  ).rejects.toMatchObject({ code: "stale_review" });
  expect(p.count()).toBe(0);
});
it("source changes after automatic creation surface attention without changing the event or approval", async () => {
  const { discordSetup } = await import("./automationHelpers.js");
  const f = await discordSetup(),
    p = provider();
  await evaluateReview(f.actor, f.id, p.gateway, { allowWrites: true });
  const q = await db.automationQuestion.findFirstOrThrow({
    where: { userId: f.user.id, status: "open" },
  });
  await answerQuestion(
    f.actor,
    q.id,
    {
      expectedRevision: q.reviewRevision,
      answer: { kind: "title", value: "Confirmed Discord Exam" },
    },
    p.gateway,
    { allowWrites: true },
  );
  expect(p.count()).toBe(1);
  const approved = await getReview(f.actor, f.id);
  const { recordDiscordChange } =
    await import("../../apps/api/src/application/discordIngestion.js");
  await recordDiscordChange(
    f.config,
    {
      kind: "update",
      payload: {
        ...f.post,
        content: f.post.content + " changed",
        edited_timestamp: new Date().toISOString(),
      },
    },
    f.binding.generation,
  );
  const activity = await listActivity(f.actor);
  expect(activity.items[0]).toMatchObject({
    decision: "ask_user",
    reason: "source_changed",
  });
  expect((await getReview(f.actor, f.id)).approvedSnapshot).toEqual(
    approved.approvedSnapshot,
  );
  expect(p.count()).toBe(1);
});
it("a failed question-state write rolls back the submitted draft correction", async () => {
  const f = await setup(),
    p = provider();
  const r = await getReview(f.actor, f.id);
  await saveReview(f.actor, f.id, r.revision, { ...r.draft, title: "" });
  const q = await question(f, p);
  const name = "question_atomic_" + crypto.randomUUID().replaceAll("-", "");
  await db.$executeRawUnsafe(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${q.id}'::uuid AND NEW.status='answered' THEN RAISE EXCEPTION 'synthetic question state failure'; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE UPDATE ON "AutomationQuestion" FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  try {
    await expect(
      answerQuestion(
        f.actor,
        q.id,
        {
          expectedRevision: q.reviewRevision,
          answer: { kind: "title", value: "Should roll back" },
        },
        p.gateway,
        { allowWrites: true },
      ),
    ).rejects.toThrow();
    const after = await getReview(f.actor, f.id);
    expect(after.draft.title).toBe("");
    expect(after.revision).toBe(q.reviewRevision);
    expect(p.count()).toBe(0);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON "AutomationQuestion"`);
    await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
  }
});
it("Ask rules offer a one-time focused approval without enabling an automatic rule", async () => {
  const f = await setup(),
    p = provider();
  const policy = await getPolicy(f.actor);
  await savePolicy(f.actor, policy.revision, {
    enabled: true,
    pollGmail: false,
    rules: [
      { connectionId: f.connection.id, category: "exam_quiz", action: "ask" },
    ],
  });
  const q = await question(f, p);
  expect(q.kind).toBe("facts");
  expect((await listActivity(f.actor)).items[0].question?.oneTimeApproval).toBe(
    true,
  );
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
  ).toBe("added");
  expect((await getPolicy(f.actor)).rules[0].action).toBe("ask");
  expect(p.count()).toBe(1);
  const approval = await db.historyEntry.findFirstOrThrow({
    where: { reviewId: f.id, action: "review_approved" },
  });
  expect(approval.actor).toBe("user");
});
