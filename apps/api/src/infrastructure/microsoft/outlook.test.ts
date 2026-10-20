import { it, expect, vi, afterEach } from "vitest";
import { outlookMail } from "./outlook.js";
const config = {
  NODE_ENV: "test" as const,
  PORT: 3000,
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgresql://synthetic@localhost/hub_test",
  GOOGLE_CLIENT_ID: "synthetic",
  GOOGLE_CLIENT_SECRET: "synthetic",
  GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
  TOKEN_ENCRYPTION_KEY: "1".repeat(64),
  PROVIDER_TIMEOUT_MS: 1000,
};
const actor = { userId: "synthetic-owner" };
const next =
  "https://graph.microsoft.com/v1.0/me/messages?$top=20&$select=id,subject,receivedDateTime&$orderby=receivedDateTime%20desc&$skip=20";
function setup() {
  let revision = 7;
  const requests: { url: string; options: RequestInit }[] = [];
  let response: unknown = {
    value: [
      {
        id: "AAMk+Case_ID=",
        subject: "Synthetic Workshop",
        receivedDateTime: "2026-10-12T12:00:00Z",
      },
    ],
    "@odata.nextLink": next,
  };
  let status = 200;
  let headers: Record<string, string> = {};
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(response), { status, headers });
  });
  const service = {
    accessToken: async () => ({
      accessToken: "synthetic-access-only",
      authorizationId: "synthetic-auth",
      revision,
    }),
    invalidate: async () => {
      revision++;
    },
  };
  return {
    mail: outlookMail(config, service),
    requests,
    response: (r: unknown, s = 200, h: Record<string, string> = {}) => {
      response = r;
      status = s;
      headers = h;
    },
    reconnect: () => {
      revision++;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
it("bounded listing uses GET, immutable IDs, no bodies and opaque pagination", async () => {
  const f = setup();
  const page = await f.mail.list(actor);
  expect(page.messages).toEqual([
    {
      id: "AAMk+Case_ID=",
      subject: "Synthetic Workshop",
      receivedAt: "2026-10-12T12:00:00.000Z",
      sender: "",
      snippet: "",
    },
  ]);
  const query = new URL(f.requests[0].url);
  expect(query.pathname).toBe("/v1.0/me/messages");
  expect(query.searchParams.get("$top")).toBe("20");
  expect(query.searchParams.get("$select")).toBe("id,subject,receivedDateTime");
  expect(query.searchParams.get("$orderby")).toBe("receivedDateTime desc");
  expect(f.requests[0].options).toMatchObject({
    method: "GET",
    redirect: "error",
    headers: { Prefer: 'IdType="ImmutableId"' },
  });
  expect(page.nextPageToken).not.toContain("graph.microsoft.com");
  f.response({ value: [] });
  expect(await f.mail.list(actor, page.nextPageToken)).toEqual({
    messages: [],
    nextPageToken: undefined,
  });
  expect(f.requests[1].url).toBe(next);
});
it("selected fetch URL-encodes stable ID and requests body only for the chosen message", async () => {
  const f = setup();
  f.response({
    id: "AAMk+Case_ID=",
    body: { contentType: "text", content: "Synthetic" },
  });
  await f.mail.get(actor, "AAMk+Case_ID=");
  const request = f.requests[0];
  expect(new URL(request.url).pathname).toBe(
    "/v1.0/me/messages/AAMk%2BCase_ID%3D",
  );
  expect(new URL(request.url).searchParams.get("$select")).toBe(
    "id,subject,receivedDateTime,body",
  );
  expect(request.options.headers).toMatchObject({
    Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
  });
});
it("cross-user, tampered, expired and reconnected pagination fail before Graph read", async () => {
  const f = setup();
  const first = await f.mail.list(actor);
  const cursor = first.nextPageToken!;
  await expect(
    f.mail.list({ userId: "another-owner" }, cursor),
  ).rejects.toMatchObject({ code: "invalid_page_token" });
  await expect(f.mail.list(actor, cursor + "tamper")).rejects.toMatchObject({
    code: "invalid_page_token",
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600001);
  try {
    await expect(f.mail.list(actor, cursor)).rejects.toMatchObject({
      code: "invalid_page_token",
    });
  } finally {
    now.mockRestore();
  }
  f.reconnect();
  await expect(f.mail.list(actor, cursor)).rejects.toMatchObject({
    code: "invalid_page_token",
  });
  expect(f.requests).toHaveLength(1);
});
it.each([
  "https://example.test/steal",
  "http://graph.microsoft.com/v1.0/me/messages",
  "https://user:password@graph.microsoft.com/v1.0/me/messages",
  "https://graph.microsoft.com/v1.0/users/other/messages",
  next.replace("$top=20", "$top=1000"),
  next.replace("id,subject,receivedDateTime", "id,body"),
  next + "&$expand=attachments",
])(
  "hostile/broadened continuation cannot become an authorized read: %s",
  async (link) => {
    const f = setup();
    f.response({ value: [], "@odata.nextLink": link });
    await expect(f.mail.list(actor)).rejects.toMatchObject({
      code: "invalid_provider_payload",
    });
    expect(f.requests).toHaveLength(1);
  },
);
it("provider payloads cannot exceed the page bound or silently become an empty mailbox", async () => {
  const f = setup();
  f.response({
    value: Array.from({ length: 21 }, (_, i) => ({
      id: String(i),
      subject: "Synthetic",
      receivedDateTime: "2026-10-12T12:00:00Z",
    })),
  });
  await expect(f.mail.list(actor)).rejects.toMatchObject({
    code: "invalid_provider_payload",
  });
  f.response({ unexpected: [] });
  await expect(f.mail.list(actor)).rejects.toMatchObject({
    code: "invalid_provider_payload",
  });
});
it.each([
  [429, "microsoft_rate_limited"],
  [401, "microsoft_reauthorization_required"],
  [403, "microsoft_connection_blocked"],
  [503, "microsoft_unavailable"],
] as const)(
  "HTTP %s produces safe failure, never no-event",
  async (status, code) => {
    const f = setup();
    f.response(
      { error: { message: "private provider response synthetic-access-only" } },
      status,
      { "Retry-After": "120" },
    );
    await expect(f.mail.list(actor)).rejects.toMatchObject({
      code,
      ...(status === 429 ? { retryAfterSeconds: 120 } : {}),
    });
    expect(f.requests).toHaveLength(1);
  },
);
it("invalid selected IDs are rejected without any Graph request", async () => {
  const f = setup();
  await expect(f.mail.get(actor, "../calendar")).rejects.toMatchObject({
    code: "invalid_selection",
  });
  await expect(f.mail.get(actor, "A".repeat(513))).rejects.toMatchObject({
    code: "invalid_selection",
  });
  expect(f.requests).toHaveLength(0);
});
