import { it, expect, vi } from "vitest";
import { googleGmail } from "./gmail.js";
const requests: Record<string, unknown>[] = [];
vi.mock("./providerClient.js", () => ({
  providerClient: async () => ({
    request: async (options: Record<string, unknown>) => {
      requests.push(options);
      if (String(options.url).endsWith("/messages"))
        return {
          data: { messages: [{ id: "selected" }], nextPageToken: "page2" },
        };
      return {
        data: {
          id: "selected",
          snippet: "Meeting",
          payload: {
            headers: [
              { name: "Subject", value: "Announcement" },
              { name: "From", value: "test@example.test" },
            ],
          },
        },
      };
    },
  }),
}));
const config = {
  NODE_ENV: "test" as const,
  PORT: 3000,
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgresql://localhost/test",
  GOOGLE_CLIENT_ID: "synthetic",
  GOOGLE_CLIENT_SECRET: "synthetic",
  GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
  TOKEN_ENCRYPTION_KEY: "1".repeat(64),
  PROVIDER_TIMEOUT_MS: 15000,
};
it("list_fetches_metadata_without_message_bodies", async () => {
  requests.length = 0;
  const page = await googleGmail(config).list({ userId: "user" }, "cursor");
  expect(page).toEqual({
    messages: [
      {
        id: "selected",
        subject: "Announcement",
        sender: "test@example.test",
        snippet: "Meeting",
      },
    ],
    nextPageToken: "page2",
  });
  expect(requests[0].params).toMatchObject({
    maxResults: 20,
    pageToken: "cursor",
  });
  expect(requests[1].params).toEqual({
    format: "metadata",
    metadataHeaders: ["Subject", "From"],
  });
  expect(
    requests.some((r) => (r.params as { format?: string }).format === "full"),
  ).toBe(false);
});
it("selected_message_fetch_uses_full_format", async () => {
  requests.length = 0;
  await googleGmail(config).get({ userId: "user" }, "selected");
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({ format: "full" });
});
it("automatic poll reads one bounded ID page without metadata or bodies", async () => {
  requests.length = 0;
  const page = await googleGmail(config).poll!(
    { userId: "user" },
    {
      after: "1970-01-01T00:01:00.000Z",
      before: "1970-01-01T00:02:00.000Z",
      pageToken: "bounded-cursor",
    },
  );
  expect(page).toEqual({ ids: ["selected"], nextPageToken: "page2" });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    method: "GET",
    params: {
      maxResults: 20,
      q: "after:60 before:120",
      pageToken: "bounded-cursor",
    },
    retry: false,
  });
});
it("automatic poll refuses an unbounded or reversed time window before provider access", async () => {
  requests.length = 0;
  await expect(
    googleGmail(config).poll!(
      { userId: "user" },
      { after: "1970-01-01T00:01:00.000Z", before: "1970-01-02T00:02:00.000Z" },
    ),
  ).rejects.toThrow();
  await expect(
    googleGmail(config).poll!(
      { userId: "user" },
      { after: "1970-01-01T00:02:00.000Z", before: "1970-01-01T00:01:00.000Z" },
    ),
  ).rejects.toThrow();
  expect(requests).toHaveLength(0);
});
