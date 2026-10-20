import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { convert } from "html-to-text";
import {
  AppError,
  type NormalizedMessage,
  type NormalizationContext,
} from "@hub/contracts";
export const outlookId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_+=/\-]+$/);
export const receivedDate = z.iso.datetime({ offset: true }).refine((value) => {
  try {
    Temporal.Instant.from(value);
    return true;
  } catch {
    return false;
  }
});
export const outlookSummary = z.object({
  id: outlookId,
  subject: z.string().max(2048).nullish(),
  receivedDateTime: receivedDate,
});
const message = outlookSummary.extend({
  body: z.object({
    contentType: z.enum(["text", "html"]),
    content: z.string().max(1048576),
  }),
});
export function normalizeOutlook(
  payload: unknown,
  context: NormalizationContext,
): NormalizedMessage {
  const parsed = message.safeParse(payload);
  if (!parsed.success) throw new AppError("invalid_provider_payload", 502);
  const p = parsed.data;
  if (Buffer.byteLength(p.body.content, "utf8") > 262144)
    throw new AppError("message_too_large", 422);
  const content = (
    p.body.contentType === "text"
      ? p.body.content
      : convert(p.body.content, {
          wordwrap: false,
          selectors: [
            { selector: "script", format: "skip" },
            { selector: "style", format: "skip" },
            { selector: "img", format: "skip" },
            { selector: "a", options: { ignoreHref: true } },
          ],
        })
  ).trim();
  if (Buffer.byteLength(content, "utf8") > 262144)
    throw new AppError("message_too_large", 422);
  return {
    ...context,
    source: "outlook",
    externalId: p.id,
    subject: p.subject || undefined,
    content,
    receivedAt: new Date(p.receivedDateTime).toISOString(),
    metadata: {},
    normalizationVersion: 1,
  };
}
