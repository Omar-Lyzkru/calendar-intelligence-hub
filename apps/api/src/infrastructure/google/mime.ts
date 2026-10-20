import { z } from "zod";
import { convert } from "html-to-text";
import { AppError, type NormalizedMessage } from "@hub/contracts";
interface Part {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}
const part: z.ZodType<Part> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    body: z
      .object({
        data: z.string().max(400000).optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(part).max(100).optional(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
  }),
);
const payloadSchema = z.object({
  id: z.string().min(1),
  internalDate: z.string().regex(/^\d+$/),
  threadId: z.string().optional(),
  payload: part,
});
export interface NormalizationContext {
  id: string;
  userId: string;
  sourceConnectionId: string;
  ingestedAt: string;
}
export function normalizeGmail(
  payload: unknown,
  context: NormalizationContext,
): NormalizedMessage {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw new AppError("invalid_provider_payload", 502);
  const p = parsed.data;
  const plain: string[] = [];
  const html: string[] = [];
  let size = 0;
  let count = 0;
  const walk = (v: Part, depth: number) => {
    if (depth > 20 || ++count > 500)
      throw new AppError("message_too_complex", 422);
    const disposition = v.headers?.find(
      (h) => h.name.toLowerCase() === "content-disposition",
    )?.value;
    if (
      v.filename ||
      v.body?.attachmentId ||
      /^attachment(?:\s*;|\s*$)/i.test(disposition?.trim() || "")
    )
      return;
    if (
      v.body?.data &&
      (v.mimeType === "text/plain" || v.mimeType === "text/html")
    ) {
      if (!/^[A-Za-z0-9_=-]*$/.test(v.body.data))
        throw new AppError("invalid_body_encoding", 502);
      const bytes = Buffer.from(v.body.data, "base64url");
      size += bytes.length;
      if (size > 262144) throw new AppError("message_too_large", 422);
      (v.mimeType === "text/plain" ? plain : html).push(bytes.toString("utf8"));
    }
    for (const c of v.parts || []) walk(c, depth + 1);
  };
  walk(p.payload, 0);
  const header = (name: string) =>
    p.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value;
  const receivedAt = new Date(Number(p.internalDate));
  if (!Number.isFinite(receivedAt.valueOf()))
    throw new AppError("invalid_received_date", 502);
  return {
    ...context,
    source: "gmail",
    externalId: p.id,
    subject: header("subject"),
    sender: header("from"),
    content: (plain.length
      ? plain.join("\n")
      : convert(html.join("\n"), {
          wordwrap: false,
          selectors: [
            { selector: "script", format: "skip" },
            { selector: "style", format: "skip" },
            { selector: "img", format: "skip" },
            { selector: "a", options: { ignoreHref: true } },
          ],
        })
    ).trim(),
    receivedAt: receivedAt.toISOString(),
    sourceUrl:
      "https://mail.google.com/mail/u/0/#all/" + encodeURIComponent(p.id),
    metadata: p.threadId ? { threadId: p.threadId } : {},
    normalizationVersion: 1,
  };
}
