import { it, expect, afterAll } from "vitest";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { fixture } from "./helpers.js";
import {
  connectRelay,
  disconnectRelay,
} from "../../apps/api/src/infrastructure/discord/connections.js";
import {
  ingestDiscord,
  recordDiscordChange,
  confirmDiscordSource,
} from "../../apps/api/src/application/discordIngestion.js";
import { getReview } from "../../apps/api/src/infrastructure/persistence/reviews.js";
import {
  saveReview,
  approveReview,
} from "../../apps/api/src/application/approveReview.js";
import {
  claimWrite,
  finishWrite,
} from "../../apps/api/src/infrastructure/persistence/calendarWrites.js";
import { deleteContent } from "../../apps/api/src/infrastructure/persistence/retention.js";
import { checkDuplicates } from "../../apps/api/src/application/checkDuplicates.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import type { DiscordConfig } from "../../apps/api/src/infrastructure/discord/config.js";
import type { CalendarGateway } from "../../apps/api/src/infrastructure/google/calendar.js";
let serial = BigInt(Date.now()) * 100000n;
async function relay() {
  const f = await fixture();
  const config: DiscordConfig = {
    token: "synthetic-token-not-real",
    guildId: String(800000000000000000n + ++serial),
    channelIds: ["800000000000001001"],
  };
  const binding = await connectRelay(f.actor, config);
  return { ...f, config, binding };
}
function post(config: DiscordConfig, overrides: Record<string, unknown> = {}) {
  return {
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
    timestamp: "2026-10-13T12:00:00Z",
    edited_timestamp: null,
    content: "Workshop October 20, 2026 at 2:00 PM to 3:00 PM Central Time",
    embeds: [],
    author: { username: "private profile not stored" },
    ...overrides,
  };
}
async function review(f: Awaited<ReturnType<typeof relay>>) {
  const result = await ingestDiscord(
    f.config,
    post(f.config),
    f.binding.generation,
  );
  if (!("reviewId" in result) || !result.reviewId)
    throw Error("expected synthetic review");
  return getReview(f.actor, result.reviewId);
}
afterAll(() => db.$disconnect());
it("binds only one workspace to a configured relay and preserves stable source identity across reconnect", async () => {
  const f = await relay(),
    foreign = await fixture();
  await expect(connectRelay(foreign.actor, f.config)).rejects.toMatchObject({
    code: "discord_relay_owned",
  });
  await disconnectRelay(f.actor);
  const next = await connectRelay(f.actor, f.config);
  expect(next.sourceConnectionId).toBe(f.binding.sourceConnectionId);
  expect(next.generation).toBeGreaterThan(f.binding.generation);
  await expect(
    db.sourceConnection.update({
      where: { id: next.sourceConnectionId },
      data: { authorizationId: f.connection.authorizationId },
    }),
  ).rejects.toThrow();
  await expect(
    db.sourceConnection.update({
      where: { id: next.sourceConnectionId },
      data: { discordRelayId: null },
    }),
  ).rejects.toThrow();
});
it("concurrent replay makes one source, candidate, attempt and history chain without storing profiles or hidden fields", async () => {
  const f = await relay();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      ingestDiscord(f.config, post(f.config), f.binding.generation),
    ),
  );
  expect(
    new Set(results.map((r) => ("reviewId" in r ? r.reviewId : null))).size,
  ).toBe(1);
  expect(
    await db.normalizedMessage.count({
      where: { sourceConnectionId: f.binding.sourceConnectionId },
    }),
  ).toBe(1);
  expect(
    await db.discordObservation.count({
      where: { sourceConnectionId: f.binding.sourceConnectionId },
    }),
  ).toBe(1);
  expect(
    await db.processingAttempt.count({
      where: { sourceConnectionId: f.binding.sourceConnectionId },
    }),
  ).toBe(1);
  expect(
    await db.historyEntry.count({
      where: { userId: f.user.id, action: "message_processed" },
    }),
  ).toBe(1);
  const d = await review(f);
  expect(d.source?.provider).toBe("discord");
  expect(d.subject).toBeNull();
  expect(d.draft.temporal).toMatchObject({
    kind: "timed",
    start: "2026-10-20T19:00:00.000Z",
    end: "2026-10-20T20:00:00.000Z",
  });
  expect(
    d.state?.readiness.blockers.some((b) => b.code === "title_required"),
  ).toBe(true);
  expect(d.candidate.classification?.category).toBe("hackathon_workshop");
  const stored = await db.normalizedMessage.findUniqueOrThrow({
    where: { id: d.messageId },
  });
  expect(stored.metadata).toEqual({ channelId: f.config.channelIds[0] });
  expect(JSON.stringify(stored)).not.toContain("private profile");
});
it("ignores ordinary chat, foreign scopes, disconnected and stale-generation deliveries", async () => {
  const f = await relay();
  for (const patch of [
    { flags: 0 },
    { guild_id: "800000000000009001" },
    { channel_id: "800000000000009002" },
  ])
    expect(
      await ingestDiscord(
        f.config,
        post(f.config, patch),
        f.binding.generation,
      ),
    ).toEqual({ status: "ignored" });
  await disconnectRelay(f.actor);
  expect(
    await ingestDiscord(f.config, post(f.config), f.binding.generation),
  ).toEqual({ status: "ignored" });
  const next = await connectRelay(f.actor, f.config);
  expect(
    await ingestDiscord(f.config, post(f.config), f.binding.generation),
  ).toEqual({ status: "ignored" });
  expect(
    (await ingestDiscord(f.config, post(f.config), next.generation)).status,
  ).toBe("review");
});
it("attachment-only and malformed sources have durable failure receipts and never false no-event results", async () => {
  const f = await relay();
  const p = post(f.config, {
    content: "",
    attachments: [{ url: "https://private.example/never-fetch" }],
  });
  for (let i = 0; i < 3; i++)
    expect(
      (await ingestDiscord(f.config, p, f.binding.generation)).status,
    ).toBe("failed");
  expect(
    await db.normalizedMessage.count({ where: { userId: f.user.id } }),
  ).toBe(0);
  expect(
    await db.processingAttempt.count({
      where: { sourceConnectionId: f.binding.sourceConnectionId },
    }),
  ).toBe(1);
  expect(
    await db.discordObservation.count({
      where: { sourceConnectionId: f.binding.sourceConnectionId },
    }),
  ).toBe(1);
  expect(
    JSON.stringify(
      await db.historyEntry.findMany({ where: { userId: f.user.id } }),
    ),
  ).not.toContain("private.example");
});
it("provider source deletion notices before first import cannot become event candidates", async () => {
  const f = await relay();
  const r = await ingestDiscord(
    f.config,
    post(f.config, { flags: 10 }),
    f.binding.generation,
  );
  expect(r.status).toBe("failed");
  expect(await db.reviewItem.count({ where: { userId: f.user.id } })).toBe(0);
});
it("edits preserve original extraction and corrected drafts, invalidate old revisions, and require explicit source confirmation", async () => {
  const f = await relay();
  let d = await review(f);
  d = await saveReview(f.actor, d.id, d.revision, {
    ...d.draft,
    title: "Synthetic Workshop",
  });
  const original = d.originalText,
    draft = d.draft;
  const changed = post(f.config, {
    content: "Updated Workshop October 21, 2026 at 2:00 PM",
    edited_timestamp: "2026-10-13T13:00:00Z",
  });
  await recordDiscordChange(
    f.config,
    { kind: "update", payload: changed },
    f.binding.generation,
  );
  const revised = await getReview(f.actor, d.id);
  expect(revised.originalText).toBe(original);
  expect(revised.draft).toEqual(draft);
  expect(revised.revision).toBe(d.revision + 1);
  expect(revised.source?.notice).toMatchObject({
    kind: "changed",
    revision: 2,
    requiresConfirmation: true,
  });
  expect(revised.state?.actions.approve).toBe(false);
  await expect(approveReview(f.actor, d.id, d.revision)).rejects.toMatchObject({
    code: "stale_review",
  });
  await expect(
    approveReview(f.actor, d.id, revised.revision),
  ).rejects.toMatchObject({ code: "source_confirmation_required" });
  await expect(
    confirmDiscordSource(f.actor, d.id, revised.revision, 1),
  ).rejects.toMatchObject({ code: "stale_review" });
  const foreign = await fixture();
  await expect(
    confirmDiscordSource(foreign.actor, d.id, revised.revision, 2),
  ).rejects.toMatchObject({ code: "not_found" });
  const ack = await confirmDiscordSource(f.actor, d.id, revised.revision, 2);
  expect(ack.status).toBe("needs_review");
  expect(ack.source?.notice?.requiresConfirmation).toBe(false);
  expect((await approveReview(f.actor, d.id, ack.revision)).status).toBe(
    "approved",
  );
});
it("duplicate/out-of-order edits and deletes produce one notice per genuine change", async () => {
  const f = await relay();
  const d = await review(f);
  const changed = post(f.config, {
    content: "Changed Workshop October 21, 2026",
    edited_timestamp: "2026-10-13T14:00:00Z",
  });
  await recordDiscordChange(
    f.config,
    { kind: "update", payload: changed },
    f.binding.generation,
  );
  await recordDiscordChange(
    f.config,
    { kind: "update", payload: changed },
    f.binding.generation,
  );
  await recordDiscordChange(
    f.config,
    {
      kind: "update",
      payload: post(f.config, { edited_timestamp: "2026-10-13T13:00:00Z" }),
    },
    f.binding.generation,
  );
  expect((await getReview(f.actor, d.id)).source?.notice?.revision).toBe(2);
  const event = {
    kind: "delete" as const,
    payload: {
      id: changed.id,
      guild_id: f.config.guildId,
      channel_id: f.config.channelIds[0],
    },
  };
  await recordDiscordChange(f.config, event, f.binding.generation);
  await recordDiscordChange(f.config, event, f.binding.generation);
  expect((await getReview(f.actor, d.id)).source?.notice).toMatchObject({
    kind: "deleted",
    revision: 3,
  });
  expect(
    await db.historyEntry.count({
      where: { userId: f.user.id, action: "discord_source_changed" },
    }),
  ).toBe(1);
  expect(
    await db.historyEntry.count({
      where: { userId: f.user.id, action: "discord_source_deleted" },
    }),
  ).toBe(1);
});
it("changed sources block new Calendar claims but retain immutable approvals and existing added receipts", async () => {
  const f = await relay();
  let d = await review(f);
  d = await saveReview(f.actor, d.id, d.revision, {
    ...d.draft,
    title: "Synthetic Workshop",
  });
  d = await approveReview(f.actor, d.id, d.revision);
  const snapshot = d.approvedSnapshot;
  const event = {
    kind: "delete" as const,
    payload: {
      id: post(f.config).id,
      guild_id: f.config.guildId,
      channel_id: f.config.channelIds[0],
    },
  };
  await recordDiscordChange(f.config, event, f.binding.generation);
  await expect(claimWrite(f.actor, d.id)).rejects.toMatchObject({
    code: "source_confirmation_required",
  });
  let revised = await getReview(f.actor, d.id);
  expect(revised.approvedSnapshot).toEqual(snapshot);
  revised = await confirmDiscordSource(
    f.actor,
    d.id,
    revised.revision,
    revised.source!.notice!.revision,
  );
  const claim = await claimWrite(f.actor, d.id);
  expect(claim.kind).toBe("claimed");
  if (claim.kind !== "claimed") throw Error("expected claim");
  const receipt = {
    providerEventId: claim.intent.providerEventId,
    calendarId: "primary",
    htmlLink: "https://calendar.google.com/synthetic",
    payloadHash: claim.intent.payloadHash,
  };
  await finishWrite(f.actor, d.id, claim.intent.id, claim.intent.claimToken, {
    status: "added",
    receipt,
  });
  // Already-completed receipt remains stable even if a later meaningful source notice arrives.
  expect(await claimWrite(f.actor, d.id)).toMatchObject({
    kind: "existing",
    outcome: { status: "added", receipt },
  });
  expect((await getReview(f.actor, d.id)).approvedSnapshot).toEqual(snapshot);
});
it("retention erases evidence and replay or edits cannot rehydrate it", async () => {
  const f = await relay();
  const d = await review(f);
  await deleteContent(f.user.id, d.messageId);
  await ingestDiscord(f.config, post(f.config), f.binding.generation);
  await recordDiscordChange(
    f.config,
    {
      kind: "update",
      payload: post(f.config, {
        content: "Private updated content",
        edited_timestamp: "2026-10-13T14:00:00Z",
      }),
    },
    f.binding.generation,
  );
  const r = await getReview(f.actor, d.id);
  expect(r.originalText).toBeNull();
  expect(r.candidate.evidence.every((e) => e.text === undefined)).toBe(true);
  expect(
    JSON.stringify(
      await db.discordObservation.findMany({
        where: { sourceConnectionId: f.binding.sourceConnectionId },
      }),
    ),
  ).not.toContain("Private updated content");
});
it("Discord reuses cross-provider duplicate/conflict advisories without exact-source deduplication conflation", async () => {
  const f = await relay();
  let d = await review(f);
  d = await saveReview(f.actor, d.id, d.revision, {
    ...d.draft,
    title: "Synthetic Workshop",
  });
  const gmail = {
    ...f.message,
    subject: "Synthetic Workshop",
    content: post(f.config).content,
    ingestedAt: new Date().toISOString(),
  };
  await saveProcessedMessage(
    f.actor,
    gmail,
    processMessage(gmail, f.user.timezone),
  );
  const calendar: CalendarGateway = {
    get: async () => null,
    insert: async () => {
      throw Error("no provider writes");
    },
    list: async () => ({
      coverage: { status: "checked" },
      events: [
        {
          key: "google:conflict",
          source: "google",
          title: "Different commitment",
          location: null,
          temporal: d.draft.temporal as any,
          availability: "busy",
        },
      ],
    }),
  };
  const result = await checkDuplicates(f.actor, d.id, d.revision, calendar);
  expect(result.matches.some((m) => m.sources.includes("local"))).toBe(true);
  expect(result.conflicts?.matches.length).toBe(1);
});
it("a genuine edit can recover a previously unsupported receipt without duplicating its exact source", async () => {
  const f = await relay();
  expect(
    (
      await ingestDiscord(
        f.config,
        post(f.config, { content: "" }),
        f.binding.generation,
      )
    ).status,
  ).toBe("failed");
  const updated = post(f.config, { edited_timestamp: "2026-10-13T15:00:00Z" });
  const result = await ingestDiscord(f.config, updated, f.binding.generation);
  expect(result.status).toBe("review");
  expect(
    await db.discordObservation.count({
      where: { sourceConnectionId: f.binding.sourceConnectionId },
    }),
  ).toBe(1);
  expect(
    await db.normalizedMessage.count({
      where: { sourceConnectionId: f.binding.sourceConnectionId },
    }),
  ).toBe(1);
  expect(
    (await ingestDiscord(f.config, updated, f.binding.generation)).status,
  ).toBe("review");
  expect(
    await db.processingAttempt.count({
      where: { sourceConnectionId: f.binding.sourceConnectionId },
    }),
  ).toBe(2);
});
it("pending source confirmation still permits read-only duplicate/conflict review without pretending record corruption", async () => {
  const f = await relay();
  let d = await review(f);
  d = await saveReview(f.actor, d.id, d.revision, {
    ...d.draft,
    title: "Synthetic Workshop",
  });
  await recordDiscordChange(
    f.config,
    {
      kind: "update",
      payload: post(f.config, {
        content: "Changed Workshop October 21, 2026",
        edited_timestamp: "2026-10-13T14:00:00Z",
      }),
    },
    f.binding.generation,
  );
  d = await getReview(f.actor, d.id);
  const calendar: CalendarGateway = {
    get: async () => null,
    insert: async () => {
      throw Error("read only");
    },
    list: async () => ({ events: [], coverage: { status: "checked" } }),
  };
  const checked = await checkDuplicates(f.actor, d.id, d.revision, calendar);
  expect(checked.google.status).toBe("checked");
  expect(checked.conflicts?.google.status).toBe("checked");
  expect(
    (await getReview(f.actor, d.id)).source?.notice?.requiresConfirmation,
  ).toBe(true);
});
it("automatic Discord ingestion physically erases expired source evidence and preserves approved snapshots", async () => {
  const f = await relay();
  let approved = await review(f);
  approved = await saveReview(f.actor, approved.id, approved.revision, {
    ...approved.draft,
    title: "Synthetic retained approval",
  });
  approved = await approveReview(f.actor, approved.id, approved.revision);
  const unresolved = await ingestDiscord(
    f.config,
    post(f.config, {
      id: "800000000000002008",
      content: "Workshop next Friday",
    }),
    f.binding.generation,
  );
  if (!("reviewId" in unresolved) || !unresolved.reviewId)
    throw Error("Expected unresolved synthetic review");
  const unknown = await getReview(f.actor, unresolved.reviewId);
  const gmail = {
    ...f.message,
    content: "Workshop next Friday",
    ingestedAt: new Date().toISOString(),
  };
  await saveProcessedMessage(
    f.actor,
    gmail,
    processMessage(gmail, f.user.timezone),
  );
  const expired = [approved.messageId, unknown.messageId, gmail.id];
  await db.normalizedMessage.updateMany({
    where: { id: { in: expired } },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  expect(
    (
      await db.normalizedMessage.findMany({ where: { id: { in: expired } } })
    ).every((m) => m.content !== null),
  ).toBe(true);
  await ingestDiscord(
    f.config,
    post(f.config, { id: "800000000000002009" }),
    f.binding.generation,
  );
  const rows = await db.normalizedMessage.findMany({
    where: { id: { in: expired } },
    include: { detected: { include: { review: true } } },
  });
  expect(rows.every((m) => m.content === null)).toBe(true);
  for (const m of rows) {
    const candidate = m.detected?.candidate as unknown as {
      evidence: Array<{ text?: string }>;
      draft: { temporal: { kind: string; text?: string } };
    };
    expect(candidate.evidence.every((e) => e.text === undefined)).toBe(true);
    if (candidate.draft.temporal.kind === "unresolved")
      expect(candidate.draft.temporal.text).toBe("");
  }
  const redacted = await db.reviewItem.findUniqueOrThrow({
    where: { id: unknown.id },
  });
  expect((redacted.draft as any).temporal.text).toBe("");
  expect(
    (await db.reviewItem.findUniqueOrThrow({ where: { id: approved.id } }))
      .approvedSnapshot,
  ).toEqual(approved.approvedSnapshot);
  expect(
    await db.historyEntry.count({
      where: {
        userId: f.user.id,
        messageId: { in: expired },
        action: "content_erased",
      },
    }),
  ).toBe(3);
  await ingestDiscord(f.config, post(f.config), f.binding.generation);
  expect(
    (
      await db.normalizedMessage.findUniqueOrThrow({
        where: { id: approved.messageId },
      })
    ).content,
  ).toBeNull();
});
