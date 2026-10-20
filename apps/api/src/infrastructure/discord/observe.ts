import { randomUUID } from "node:crypto";
import { processMessage } from "../../application/processMessage.js";
import { isFollowRelay, normalizeDiscord } from "./normalize.js";
import type { DiscordConfig } from "./config.js";
export function observeMessages(payloads: unknown[], config: DiscordConfig) {
  const report = {
    manualReadable: 0,
    followedReadable: 0,
    unsupportedOrInvalid: 0,
    reviewCandidates: 0,
    noEventResults: 0,
  };
  for (const payload of payloads) {
    try {
      const message = normalizeDiscord(
        payload,
        {
          id: randomUUID(),
          userId: randomUUID(),
          sourceConnectionId: randomUUID(),
          ingestedAt: new Date().toISOString(),
        },
        config,
        "manual-smoke",
      );
      if (isFollowRelay(payload, config)) report.followedReadable++;
      else report.manualReadable++;
      const result = processMessage(message, "America/Chicago");
      if (result.kind === "review") report.reviewCandidates++;
      else report.noEventResults++;
    } catch {
      report.unsupportedOrInvalid++;
    }
  }
  return report;
}
