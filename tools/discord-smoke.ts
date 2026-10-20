// Explicit read-only manual smoke utility. Never imported by the API/runtime.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { readDiscordConfig } from "../apps/api/src/infrastructure/discord/config.js";
import {
  DiscordRest,
  DiscordAccessError,
} from "../apps/api/src/infrastructure/discord/rest.js";
import { observeMessages } from "../apps/api/src/infrastructure/discord/observe.js";
import { AppError } from "@hub/contracts";
const allowed = new Set([
  "discord_content_intent_required",
  "discord_permissions_excessive",
  "discord_permissions_required",
  "discord_token_invalid",
  "discord_rate_limited",
  "discord_invalid_source",
  "discord_source_missing",
  "discord_unavailable",
  "discord_invalid_payload",
  "message_too_large",
  "invalid_provider_payload",
]);
try {
  const input = parseEnv(readFileSync(process.argv[2] || ".env", "utf8"));
  const config = readDiscordConfig(input);
  if (!config) throw Error();
  const rest = new DiscordRest(config);
  await rest.checkAccess();
  const messages = await rest.getMessages(config.channelIds[0]);
  const sample = messages.find((m) => typeof m.id === "string");
  let repeatedIdStable = false;
  if (sample) {
    const again = await rest.getMessage(
      config.channelIds[0],
      String(sample.id),
    );
    repeatedIdStable = again.id === sample.id;
  }
  console.log(
    JSON.stringify({
      mode: "manual-channel-read-only-in-memory",
      accessVerified: true,
      ...observeMessages(messages, config),
      repeatedIdStable,
      followAcceptanceVerified: false,
      persisted: false,
      providerWrites: 0,
      calendarWrites: 0,
    }),
  );
} catch (error) {
  const code =
    error instanceof AppError && allowed.has(error.code)
      ? error.code
      : "discord_smoke_unavailable";
  console.log(
    JSON.stringify({
      mode: "manual-channel-read-only-in-memory",
      accessVerified: false,
      errorCategory: code,
      ...(error instanceof DiscordAccessError
        ? {
            permissionChanges: error.permissionChanges,
            permissionScope: error.scope,
          }
        : {}),
      persisted: false,
      providerWrites: 0,
      calendarWrites: 0,
      followAcceptanceVerified: false,
    }),
  );
  process.exitCode = 1;
}
