import {
  AppError,
  AutomationPolicyInputSchema,
  type Actor,
  type AutomationPolicyInput,
} from "@hub/contracts";
import { db, json } from "../../infrastructure/persistence/db.js";
import { withActionLock } from "./actionLock.js";
export async function getPolicy(actor: Actor) {
  // Prisma's empty-update upsert may race on first read; use database conflict handling.
  let row = await db.automationPolicy.findUnique({
    where: { userId: actor.userId },
  });
  if (!row) {
    await db.automationPolicy.createMany({
      data: [{ userId: actor.userId }],
      skipDuplicates: true,
    });
    row = await db.automationPolicy.findUniqueOrThrow({
      where: { userId: actor.userId },
    });
  }
  return {
    ...row,
    rules: AutomationPolicyInputSchema.shape.rules.parse(row.rules),
  };
}
export async function savePolicy(
  actor: Actor,
  expectedRevision: number,
  input: AutomationPolicyInput,
) {
  const parsed = AutomationPolicyInputSchema.parse(input);
  return withActionLock(actor, async () => {
    const current = await getPolicy(actor);
    if (current.revision !== expectedRevision)
      throw new AppError("stale_review", 409);
    const connections = await db.sourceConnection.findMany({
      where: {
        userId: actor.userId,
        id: { in: [...new Set(parsed.rules.map((r) => r.connectionId))] },
      },
      include: { discordRelay: true },
    });
    if (
      parsed.rules.some(
        (r) =>
          !connections.some(
            (c) =>
              c.id === r.connectionId &&
              (!r.channelId ||
                (c.provider === "discord" &&
                  c.discordRelay?.channelIds.includes(r.channelId))),
          ),
      )
    )
      throw new AppError("not_found", 404);
    const optInAt = new Date();
    const newPollingOptIn =
      parsed.enabled &&
      parsed.pollGmail &&
      (!current.enabled || !current.pollGmail);
    await db.$transaction(async (tx) => {
      const result = await tx.automationPolicy.updateMany({
        where: { userId: actor.userId, revision: expectedRevision },
        data: {
          ...parsed,
          rules: json(parsed.rules),
          revision: { increment: 1 },
          enabledAt: parsed.enabled
            ? current.enabled
              ? current.enabledAt
              : optInAt
            : null,
          gmailPollingEnabledAt:
            parsed.enabled && parsed.pollGmail
              ? newPollingOptIn
                ? optInAt
                : current.gmailPollingEnabledAt
              : null,
        },
      });
      if (result.count !== 1) throw new AppError("stale_review", 409);
      await tx.automationQuestion.updateMany({
        where: { userId: actor.userId, status: "open" },
        data: { status: "invalidated", closedAt: new Date() },
      });
      await tx.automationDecision.updateMany({
        where: {
          userId: actor.userId,
          reason: {
            notIn: ["added", "already_added", "user_ignored", "no_event"],
          },
        },
        data: {
          decision: "blocked",
          reason: "stale",
          confirmedFields: [],
          confirmedRevision: null,
          duplicateFingerprint: null,
          conflictFingerprint: null,
        },
      });
      // A fresh opt-in is a new bounded collection window, never an old cursor replay.
      if ((!current.enabled && parsed.enabled) || newPollingOptIn)
        await tx.ingestionPoll.deleteMany({ where: { userId: actor.userId } });
      await tx.historyEntry.create({
        data: {
          userId: actor.userId,
          action: "automation_policy_changed",
          actor: "user",
        },
      });
    });
    return getPolicy(actor);
  });
}
