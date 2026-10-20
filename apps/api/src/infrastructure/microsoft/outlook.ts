import { z } from "zod";
import {
  AppError,
  type Actor,
  type MessageSourceAdapter,
} from "@hub/contracts";
import type { Config } from "../../config/env.js";
import type { MicrosoftOAuthService } from "./oauth.js";
import { encryptToken, decryptToken } from "../google/tokenVault.js";
import { boundedJson } from "./network.js";
import { normalizeOutlook, outlookId, outlookSummary } from "./normalize.js";
const origin = "https://graph.microsoft.com",
  path = "/v1.0/me/messages";
const selection = "id,subject,receivedDateTime",
  order = "receivedDateTime desc";
const listing = z.object({
  value: z.array(outlookSummary).max(20),
  "@odata.nextLink": z.string().max(6000).optional(),
});
const cursorSchema = z.object({
  userId: z.string(),
  authorizationId: z.string(),
  revision: z.number().int(),
  expiresAt: z.number(),
  url: z.string().max(6000),
});
function continuation(value: string): string {
  try {
    const u = new URL(value),
      keys = [...u.searchParams.keys()];
    if (
      u.origin !== origin ||
      u.pathname !== path ||
      u.username ||
      u.password ||
      u.hash ||
      keys.some(
        (k) =>
          !["$top", "$select", "$orderby", "$skip", "$skiptoken"].includes(k),
      ) ||
      new Set(keys).size !== keys.length ||
      u.searchParams.get("$top") !== "20" ||
      u.searchParams.get("$select") !== selection ||
      u.searchParams.get("$orderby") !== order
    )
      throw Error("invalid");
    return value;
  } catch {
    throw new AppError("invalid_provider_payload", 502);
  }
}
export function outlookMail(
  config: Config,
  oauth: Pick<MicrosoftOAuthService, "accessToken" | "invalidate">,
): MessageSourceAdapter {
  async function read(
    actor: Actor,
    url: string,
    body = false,
    expected?: z.infer<typeof cursorSchema>,
  ): Promise<{ payload: unknown; authorizationId: string; revision: number }> {
    const auth = await oauth.accessToken(actor);
    if (
      expected &&
      (auth.authorizationId !== expected.authorizationId ||
        auth.revision !== expected.revision)
    )
      throw new AppError("invalid_page_token", 422);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(config.PROVIDER_TIMEOUT_MS),
        headers: {
          Authorization: "Bearer " + auth.accessToken,
          Prefer:
            'IdType="ImmutableId"' +
            (body ? ', outlook.body-content-type="text"' : ""),
        },
      });
      if (response.status === 429) {
        const error = new AppError("microsoft_rate_limited", 429);
        const retry = response.headers.get("retry-after");
        const seconds =
          retry && /^\d+$/.test(retry)
            ? Number(retry)
            : retry
              ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
              : 60;
        error.retryAfterSeconds = Number.isFinite(seconds)
          ? Math.max(1, Math.min(86400, seconds))
          : 60;
        throw error;
      }
      if (response.status === 401 || response.status === 403) {
        const blocked = response.status === 403;
        await oauth.invalidate(
          actor,
          auth.authorizationId,
          auth.revision,
          blocked ? "blocked" : "reauthorization_required",
        );
        throw new AppError(
          blocked
            ? "microsoft_connection_blocked"
            : "microsoft_reauthorization_required",
          403,
        );
      }
      if (!response.ok) throw new AppError("microsoft_unavailable", 503);
      return {
        payload: await boundedJson(response),
        authorizationId: auth.authorizationId,
        revision: auth.revision,
      };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("microsoft_unavailable", 503);
    }
  }
  return {
    provider: "outlook",
    normalize: normalizeOutlook,
    list: async (actor, pageToken) => {
      let expected: z.infer<typeof cursorSchema> | undefined, url: string;
      if (pageToken) {
        try {
          expected = cursorSchema.parse(
            JSON.parse(decryptToken(pageToken, config.TOKEN_ENCRYPTION_KEY)),
          );
          if (
            expected.userId !== actor.userId ||
            expected.expiresAt <= Date.now()
          )
            throw Error("invalid");
          url = continuation(expected.url);
        } catch {
          throw new AppError("invalid_page_token", 422);
        }
      } else {
        const u = new URL(origin + path);
        u.searchParams.set("$top", "20");
        u.searchParams.set("$select", selection);
        u.searchParams.set("$orderby", order);
        url = u.toString();
      }
      const result = await read(actor, url, false, expected);
      const parsed = listing.safeParse(result.payload);
      if (!parsed.success) throw new AppError("invalid_provider_payload", 502);
      const next = parsed.data["@odata.nextLink"];
      return {
        messages: parsed.data.value.map((m) => ({
          id: m.id,
          subject: m.subject || "",
          sender: "",
          snippet: "",
          receivedAt: new Date(m.receivedDateTime).toISOString(),
        })),
        nextPageToken: next
          ? encryptToken(
              JSON.stringify({
                userId: actor.userId,
                authorizationId: result.authorizationId,
                revision: result.revision,
                expiresAt: Date.now() + 600000,
                url: continuation(next),
              }),
              config.TOKEN_ENCRYPTION_KEY,
            )
          : undefined,
      };
    },
    get: async (actor, id) => {
      if (!outlookId.safeParse(id).success)
        throw new AppError("invalid_selection", 422);
      const url = new URL(origin + path + "/" + encodeURIComponent(id));
      url.searchParams.set("$select", selection + ",body");
      return (await read(actor, url.toString(), true)).payload;
    },
  };
}
