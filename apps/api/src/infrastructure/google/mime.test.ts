import { it, expect } from "vitest";
import { normalizeGmail } from "./mime.js";
const part = (mimeType: string, text: string, filename = "") => ({
  mimeType,
  filename,
  body: { data: Buffer.from(text).toString("base64url") },
});
const ctx = {
  id: "i",
  userId: "u",
  sourceConnectionId: "c",
  ingestedAt: "2026-10-07T12:00:00Z",
};
const payload = (parts: unknown[]) => ({
  id: "external",
  internalDate: "1791374400000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [{ name: "Subject", value: "Meeting" }],
    parts,
  },
});
it("nested_mime_prefers_plain_text", () => {
  expect(
    normalizeGmail(
      payload([
        {
          mimeType: "multipart/alternative",
          parts: [
            part("text/html", "<b>HTML</b>"),
            part("text/plain", "Plain"),
          ],
        },
      ]),
      ctx,
    ).content,
  ).toBe("Plain");
});
it("html_fallback_removes_script_and_remote_content", () => {
  const r = normalizeGmail(
    payload([
      part(
        "text/html",
        '<script>bad()</script><img src="https://example.com/x"><p>Meeting</p>',
      ),
    ]),
    ctx,
  );
  expect(r.content).toBe("Meeting");
});
it("attachment_is_not_read", () => {
  expect(
    normalizeGmail(
      payload([
        part("text/plain", "private attachment", "file.txt"),
        part("text/plain", "Meeting"),
      ]),
      ctx,
    ).content,
  ).toBe("Meeting");
});
it("invalid_provider_payload_is_rejected", () => {
  expect(() => normalizeGmail({}, ctx)).toThrow();
});
it("oversized_body_is_rejected", () => {
  expect(() =>
    normalizeGmail(payload([part("text/plain", "a".repeat(262145))]), ctx),
  ).toThrow();
});

it("unnamed_attachment_disposition_is_excluded", () => {
  const attachment = {
    ...part("text/plain", "Private attachment"),
    headers: [{ name: "Content-Disposition", value: "attachment" }],
  };
  const r = normalizeGmail(
    payload([
      {
        mimeType: "multipart/mixed",
        parts: [attachment, part("text/html", "<p>Workshop</p>")],
      },
    ]),
    ctx,
  );
  expect(r.content).toBe("Workshop");
});
