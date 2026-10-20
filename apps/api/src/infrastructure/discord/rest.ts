import { AppError } from "@hub/contracts";
import { boundedJson } from "../microsoft/network.js";
import { isSnowflake, type DiscordConfig } from "./config.js";
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("discord_invalid_payload", 502);
  return value as Record<string, unknown>;
};
const bits = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^\d{1,20}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new AppError("discord_invalid_payload", 502);
  return BigInt(value);
};
const permissionLabels: [bigint, string][] = [
  [8n, "Administrator"],
  [16n, "Manage Channels"],
  [32n, "Manage Server"],
  [2048n, "Send Messages"],
  [8192n, "Manage Messages"],
  [268435456n, "Manage Roles"],
  [536870912n, "Manage Webhooks"],
  [1099511627776n, "Moderate Members"],
  [17179869184n, "Manage Threads"],
  [274877906944n, "Send Messages in Threads"],
];
export class DiscordAccessError extends AppError {
  constructor(
    public permissionChanges: string[],
    public scope: "server" | "feed",
  ) {
    super("discord_permissions_excessive", 403);
  }
}
export class DiscordRest {
  private readonly checked = new Set<string>();
  constructor(
    readonly config: DiscordConfig,
    private readonly timeout = 15000,
  ) {}
  private async get(path: string): Promise<unknown> {
    try {
      const response = await fetch("https://discord.com/api/v10" + path, {
        method: "GET",
        headers: {
          Authorization: "Bot " + this.config.token,
          "User-Agent":
            "DiscordBot (https://github.com/Omar-Lyzkru/calendar-intelligence-hub, 1.0)",
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeout),
      });
      if (response.status === 401)
        throw new AppError("discord_token_invalid", 403);
      if (response.status === 403)
        throw new AppError("discord_permissions_required", 403);
      if (response.status === 404)
        throw new AppError("discord_source_missing", 404);
      if (response.status === 429) {
        let delay = Number(response.headers.get("retry-after"));
        if (!Number.isFinite(delay) || delay <= 0) {
          try {
            delay = Number(object(await boundedJson(response)).retry_after);
          } catch {
            delay = 60;
          }
        }
        const error = new AppError("discord_rate_limited", 429);
        error.retryAfterSeconds = Math.max(
          1,
          Math.min(
            86400,
            Math.ceil(Number.isFinite(delay) && delay > 0 ? delay : 60),
          ),
        );
        throw error;
      }
      if (!response.ok) throw new AppError("discord_unavailable", 503);
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("discord_unavailable", 503);
    }
  }
  private channelId(id: string) {
    if (!isSnowflake(id) || !this.config.channelIds.includes(id))
      throw new AppError("discord_invalid_source", 422);
  }
  async getChannel(id: string) {
    this.channelId(id);
    const channel = object(await this.get("/channels/" + id));
    if (
      channel.guild_id !== this.config.guildId ||
      channel.type !== 0 ||
      channel.id !== id
    )
      throw new AppError("discord_invalid_source", 422);
    this.checked.add(id);
    return channel;
  }
  private async proveChannel(id: string) {
    this.channelId(id);
    if (!this.checked.has(id)) await this.getChannel(id);
  }
  private message(
    payload: unknown,
    channelId: string,
  ): Record<string, unknown> {
    const m = object(payload);
    if (
      !isSnowflake(m.id) ||
      m.channel_id !== channelId ||
      (m.guild_id !== undefined && m.guild_id !== this.config.guildId)
    )
      throw new AppError("discord_invalid_payload", 502);
    return { ...m, guild_id: this.config.guildId };
  }
  async getMessages(channelId: string) {
    await this.proveChannel(channelId);
    const rows = await this.get(
      "/channels/" + channelId + "/messages?limit=100",
    );
    if (!Array.isArray(rows) || rows.length > 100)
      throw new AppError("discord_invalid_payload", 502);
    return rows.map((r) => this.message(r, channelId));
  }
  async getMessage(channelId: string, id: string) {
    this.channelId(channelId);
    if (!isSnowflake(id)) throw new AppError("discord_invalid_source", 422);
    await this.proveChannel(channelId);
    const row = this.message(
      await this.get("/channels/" + channelId + "/messages/" + id),
      channelId,
    );
    if (row.id !== id) throw new AppError("discord_invalid_payload", 502);
    return row;
  }
  async getGateway() {
    return object(await this.get("/gateway/bot"));
  }
  async checkAccess() {
    const app = object(await this.get("/oauth2/applications/@me"));
    if (
      typeof app.flags !== "number" ||
      !Number.isInteger(app.flags) ||
      !(app.flags & (262144 | 524288))
    )
      throw new AppError("discord_content_intent_required", 403);
    const self = object(await this.get("/users/@me"));
    if (!isSnowflake(self.id))
      throw new AppError("discord_invalid_payload", 502);
    const roles = await this.get("/guilds/" + this.config.guildId + "/roles");
    if (!Array.isArray(roles) || roles.length > 250)
      throw new AppError("discord_invalid_payload", 502);
    const member = object(
      await this.get("/guilds/" + this.config.guildId + "/members/" + self.id),
    );
    if (!Array.isArray(member.roles) || !member.roles.every(isSnowflake))
      throw new AppError("discord_invalid_payload", 502);
    const ownRoles = new Set([this.config.guildId, ...member.roles]);
    let base = 0n;
    for (const raw of roles) {
      const role = object(raw);
      if (ownRoles.has(role.id as string)) base |= bits(role.permissions);
    }
    if (base & (8n | 16n | 32n | 268435456n | 536870912n))
      throw new DiscordAccessError(
        permissionLabels
          .filter(
            ([bit]) =>
              !!(base & bit) &&
              (bit === 8n ||
                bit === 16n ||
                bit === 32n ||
                bit === 268435456n ||
                bit === 536870912n),
          )
          .map(([, label]) => label),
        "server",
      );
    for (const id of this.config.channelIds) {
      const channel = await this.getChannel(id);
      const overrides = channel.permission_overwrites || [];
      if (!Array.isArray(overrides) || overrides.length > 1000)
        throw new AppError("discord_invalid_payload", 502);
      let effective = base,
        roleAllow = 0n,
        roleDeny = 0n,
        memberAllow = 0n,
        memberDeny = 0n;
      for (const raw of overrides) {
        const o = object(raw);
        if (!isSnowflake(o.id) || (o.type !== 0 && o.type !== 1))
          throw new AppError("discord_invalid_payload", 502);
        const allow = bits(o.allow),
          deny = bits(o.deny);
        if (o.type === 0 && o.id === this.config.guildId)
          effective = (effective & ~deny) | allow;
        else if (o.type === 0 && ownRoles.has(o.id)) {
          roleAllow |= allow;
          roleDeny |= deny;
        } else if (o.type === 1 && o.id === self.id) {
          memberAllow = allow;
          memberDeny = deny;
        }
      }
      effective = (effective & ~roleDeny) | roleAllow;
      effective = (effective & ~memberDeny) | memberAllow;
      if ((effective & 66560n) !== 66560n)
        throw new AppError("discord_permissions_required", 403);
      if (permissionLabels.some(([bit]) => !!(effective & bit)))
        throw new DiscordAccessError(
          permissionLabels
            .filter(([bit]) => !!(effective & bit))
            .map(([, label]) => label),
          "feed",
        );
    }
  }
}
