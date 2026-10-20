import { it, expect } from "vitest";
import { normalizeOutlook } from "./normalize.js";
const context = {
  id: "local",
  userId: "owner",
  sourceConnectionId: "outlook-source",
  ingestedAt: "2026-10-12T12:00:00.000Z",
};
const message = {
  id: "AAMk+CaseSensitive_ID=",
  subject: "Synthetic Workshop",
  receivedDateTime: "2026-10-12T07:00:00-05:00",
  body: {
    contentType: "text",
    content: "Workshop October 20, 2026 at 2:00 PM to 3:00 PM Central Time",
  },
};
it("Outlook text normalizes identity, offset timestamp and allowlisted fields only", () => {
  const result = normalizeOutlook(
    {
      ...message,
      webLink: "https://example.test/private?secret=synthetic",
      conversationId: "unused",
      from: { emailAddress: { address: "private@example.test" } },
      extra: "discard",
    },
    context,
  );
  expect(result).toMatchObject({
    ...context,
    source: "outlook",
    externalId: "AAMk+CaseSensitive_ID=",
    receivedAt: "2026-10-12T12:00:00.000Z",
    metadata: {},
    normalizationVersion: 1,
  });
  expect(result.content).toContain("Workshop");
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result.sender).toBeUndefined();
  expect(result.sourceUrl).toBeUndefined();
});
it("HTML converts entities and visible links without scripts, images or href secrets", () => {
  const result = normalizeOutlook(
    {
      ...message,
      body: {
        contentType: "html",
        content:
          '<style>private-style</style><script>private-script</script><p>Workshop &amp; Q&amp;A</p><a href="https://example.test/?secret=private">Register</a><img src="private-image">',
      },
    },
    context,
  );
  expect(result.content).toContain("Workshop & Q&A");
  expect(result.content).toContain("Register");
  expect(result.content).not.toMatch(/private|https:|<p>/);
});
it("explicit empty text is a valid empty source", () => {
  expect(
    normalizeOutlook(
      { ...message, body: { contentType: "text", content: "" } },
      context,
    ).content,
  ).toBe("");
});
it.each([
  { body: undefined },
  { body: null },
  { body: { contentType: "text" } },
  { body: { contentType: "rtf", content: "unsupported" } },
  { receivedDateTime: "2026-10-12T07:00:00" },
  { receivedDateTime: "2026-02-30T07:00:00Z" },
  { id: "../other-resource" },
  { id: " id" },
])(
  "missing body or malformed provider facts fail normalization %#",
  (patch) => {
    expect(() => normalizeOutlook({ ...message, ...patch }, context)).toThrow();
  },
);
it.each(["x".repeat(262145), "😀".repeat(65537)])(
  "body limit measures UTF-8 bytes",
  (content) => {
    expect(() =>
      normalizeOutlook(
        { ...message, body: { contentType: "text", content } },
        context,
      ),
    ).toThrowError("message_too_large");
  },
);
