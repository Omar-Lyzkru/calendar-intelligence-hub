import { projectDispatch } from "./dispatch.js";
import { GatewayIntentBits } from "discord-api-types/v10";
import { parentPort, workerData } from "node:worker_threads";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { REST } from "@discordjs/rest";
import { DiscordRest } from "./rest.js";
import { readDiscordConfig } from "./config.js";
// Worker isolation gives shutdown/retry exhaustion a hard boundary even when the SDK has scheduled reconnect work.
const config = readDiscordConfig({
  DISCORD_BOT_TOKEN: workerData?.token,
  DISCORD_GUILD_ID: workerData?.guildId,
  DISCORD_CHANNEL_IDS: workerData?.channelIds?.join(","),
});
if (!config || !parentPort)
  throw new Error("Discord worker configuration unavailable");
const send = (event: unknown) => parentPort!.postMessage(event);
const scopedRest = new DiscordRest(config);
const rest = new REST({
  version: "10",
  retries: 0,
  timeout: 15000,
  rejectOnRateLimit: () => true,
});
// The maintained SDK uses GET /gateway/bot only. Route it through the same fixed-origin bounded transport.
rest.get = async (route) => {
  if (route !== "/gateway/bot")
    throw new Error("Unsupported Gateway discovery route");
  const data = await scopedRest.getGateway();
  if (
    typeof data.url !== "string" ||
    new URL(data.url).origin !== "wss://gateway.discord.gg" ||
    !Number.isInteger(data.shards) ||
    Number(data.shards) < 1
  )
    throw new Error("Invalid Gateway discovery");
  return data;
};
const manager = new WebSocketManager({
  token: config.token,
  intents:
    GatewayIntentBits.Guilds |
    GatewayIntentBits.GuildMessages |
    GatewayIntentBits.MessageContent,
  rest,
  version: "10",
  shardCount: 1,
  shardIds: [0],
  helloTimeout: 15000,
  handshakeTimeout: 15000,
  readyTimeout: 30000,
});
manager.on(WebSocketShardEvents.Error, () => send({ kind: "failure" }));
manager.on(WebSocketShardEvents.SocketError, () => {});
manager.on(WebSocketShardEvents.Closed, (code) =>
  send({ kind: "closed", code }),
);
let botId: string | undefined;
manager.on(WebSocketShardEvents.Ready, (data) => {
  botId = data.user.id;
  send({ kind: "ready" });
});
manager.on(WebSocketShardEvents.Resumed, () => send({ kind: "resumed" }));
manager.on(WebSocketShardEvents.Dispatch, (event) => {
  for (const projected of projectDispatch(event, config, botId))
    send(projected);
});
void manager.connect().catch(() => send({ kind: "failure" }));
