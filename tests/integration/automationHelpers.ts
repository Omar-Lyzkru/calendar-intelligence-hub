import { expect } from "vitest";
import { fixture } from "./helpers.js";
import {
  getPolicy,
  savePolicy,
} from "../../apps/api/src/application/automation/policyStore.js";
import { processMessage } from "../../apps/api/src/application/processMessage.js";
import { saveProcessedMessage } from "../../apps/api/src/infrastructure/persistence/messages.js";
import type { CalendarGateway } from "../../apps/api/src/infrastructure/google/calendar.js";
import {
  AppError,
  type CalendarReceipt,
  type NormalizedMessage,
} from "@hub/contracts";
export async function setup(
  enabled = true,
  overrides: Partial<NormalizedMessage> = {},
) {
  const f = await fixture();
  const p = await getPolicy(f.actor);
  await savePolicy(f.actor, p.revision, {
    enabled,
    pollGmail: false,
    rules: [
      { connectionId: f.connection.id, category: "exam_quiz", action: "auto" },
    ],
  });
  const message = {
    ...f.message,
    receivedAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    subject: "Synthetic Exam",
    content:
      "Exam October 20, 2026 at 2:00 PM to 3:00 PM America/Chicago. PRIVATE_SOURCE_SENTINEL",
    ...overrides,
  };
  const processed = processMessage(message, "America/Chicago");
  expect(processed.kind).toBe("review");
  const saved = await saveProcessedMessage(f.actor, message, processed);
  if (!saved.reviewId) throw Error("missing synthetic review");
  return { ...f, message, id: saved.reviewId };
}
export function provider() {
  const records = new Map<string, CalendarReceipt>();
  let inserts = 0;
  let lose = false;
  const gateway: CalendarGateway = {
    list: async () => ({ events: [], coverage: { status: "checked" } }),
    get: async (_a, id) => records.get(id) || null,
    insert: async (_a, id, _e, hash) => {
      inserts++;
      const receipt = {
        providerEventId: id,
        calendarId: "primary",
        htmlLink: "https://calendar.google.com/calendar/event?eid=synthetic",
        payloadHash: hash,
      };
      records.set(id, receipt);
      if (lose) throw new AppError("provider_timeout", 503);
      return receipt;
    },
  };
  return {
    gateway,
    count: () => inserts,
    lose: () => {
      lose = true;
    },
  };
}
export async function discordSetup() {
  const f = await fixture();
  const { connectRelay } =
    await import("../../apps/api/src/infrastructure/discord/connections.js");
  const { ingestDiscord } =
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
  return { ...f, config, binding, post, id: saved.reviewId };
}
