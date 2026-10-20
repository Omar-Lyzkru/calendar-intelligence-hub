import { z } from "zod";
import { AppError, type Actor, type MessagePage } from "@hub/contracts";
import type { Config } from "../../config/env.js";
import { providerClient } from "./providerClient.js";
import { GMAIL_SCOPE } from "./oauth.js";
export interface GmailGateway {
  poll?(
    actor: Actor,
    window: { after: string; before: string; pageToken?: string },
  ): Promise<{ ids: string[]; nextPageToken?: string }>;
  list(actor: Actor, pageToken?: string): Promise<MessagePage>;
  get(actor: Actor, externalId: string): Promise<unknown>;
}
const listing = z.object({
  messages: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});
const summary = z.object({
  id: z.string(),
  snippet: z.string().default(""),
  payload: z.object({
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .default([]),
  }),
});
export function googleGmail(config: Config): GmailGateway {
  return {
    poll: async (actor, window) => {
      const after = Date.parse(window.after),
        before = Date.parse(window.before);
      if (
        !Number.isFinite(after) ||
        !Number.isFinite(before) ||
        before <= after ||
        before - after > 3600000
      )
        throw new AppError("invalid_input", 422);
      const client = await providerClient(actor, GMAIL_SCOPE, config);
      try {
        const data = listing
          .extend({
            messages: z
              .array(z.object({ id: z.string().min(1).max(128) }))
              .max(20)
              .default([]),
            nextPageToken: z.string().max(2048).optional(),
          })
          .parse(
            (
              await client.request<unknown>({
                url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                method: "GET",
                params: {
                  maxResults: 20,
                  q: `after:${Math.floor(after / 1000)} before:${Math.ceil(before / 1000)}`,
                  pageToken: window.pageToken,
                },
                timeout: config.PROVIDER_TIMEOUT_MS,
                retry: false,
              })
            ).data,
          );
        return {
          ids: data.messages.map((m) => m.id),
          ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
        };
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response
          ?.status;
        throw new AppError(
          status === 429 ? "provider_rate_limited" : "gmail_list_unavailable",
          status === 429 ? 429 : 503,
        );
      }
    },
    list: async (actor, pageToken) => {
      const client = await providerClient(actor, GMAIL_SCOPE, config);
      try {
        const page = listing.parse(
          (
            await client.request<unknown>({
              url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
              params: { maxResults: 20, pageToken },
              timeout: config.PROVIDER_TIMEOUT_MS,
              retry: false,
            })
          ).data,
        );
        const messages = [];
        for (const item of page.messages) {
          const data = summary.parse(
            (
              await client.request<unknown>({
                url:
                  "https://gmail.googleapis.com/gmail/v1/users/me/messages/" +
                  encodeURIComponent(item.id),
                params: {
                  format: "metadata",
                  metadataHeaders: ["Subject", "From"],
                },
                timeout: config.PROVIDER_TIMEOUT_MS,
                retry: false,
              })
            ).data,
          );
          const header = (name: string) =>
            data.payload.headers.find((h) => h.name.toLowerCase() === name)
              ?.value || "";
          messages.push({
            id: data.id,
            subject: header("subject"),
            sender: header("from"),
            snippet: data.snippet,
          });
        }
        return { messages, nextPageToken: page.nextPageToken };
      } catch {
        throw new AppError("gmail_list_unavailable", 503);
      }
    },
    get: async (actor, id) => {
      const client = await providerClient(actor, GMAIL_SCOPE, config);
      try {
        return (
          await client.request<unknown>({
            url:
              "https://gmail.googleapis.com/gmail/v1/users/me/messages/" +
              encodeURIComponent(id),
            params: { format: "full" },
            timeout: config.PROVIDER_TIMEOUT_MS,
            retry: false,
          })
        ).data;
      } catch {
        throw new AppError("gmail_fetch_unavailable", 503);
      }
    },
  };
}
