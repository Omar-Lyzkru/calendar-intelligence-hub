import { it, expect, vi, afterEach } from "vitest";
import { boundedJson, microsoftNetwork } from "./network.js";
afterEach(() => vi.unstubAllGlobals());
it("bounded JSON rejects oversized and malformed external data", async () => {
  await expect(
    boundedJson(new Response("x".repeat(1025)), 1024),
  ).rejects.toMatchObject({ code: "message_too_large" });
  await expect(boundedJson(new Response("not JSON"))).rejects.toMatchObject({
    code: "invalid_provider_payload",
  });
  expect(await boundedJson(new Response('{"synthetic":true}'))).toEqual({
    synthetic: true,
  });
});
it("MSAL HTTP refuses alternate hosts, embedded credentials and redirects", async () => {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    return new Response("", {
      status: 302,
      headers: { location: "https://example.test" },
    });
  });
  const network = microsoftNetwork(1000);
  await expect(
    network.sendGetRequestAsync("https://example.test/token"),
  ).rejects.toMatchObject({ code: "microsoft_unavailable" });
  await expect(
    network.sendGetRequestAsync(
      "https://user:password@login.microsoftonline.com/token",
    ),
  ).rejects.toMatchObject({ code: "microsoft_unavailable" });
  expect(fetched).toEqual([]);
  await expect(
    network.sendGetRequestAsync(
      "https://login.microsoftonline.com/common/discovery/instance",
    ),
  ).rejects.toMatchObject({ code: "microsoft_unavailable" });
});
it("MSAL token transport stays backend-only and disables automatic redirects", async () => {
  let options: RequestInit | undefined;
  vi.stubGlobal("fetch", async (_url: string, o: RequestInit) => {
    options = o;
    return new Response('{"access_token":"synthetic-only"}');
  });
  const result = await microsoftNetwork(1000).sendPostRequestAsync(
    "https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/oauth2/v2.0/token",
    {
      body: "synthetic-form",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
  expect(options).toMatchObject({
    method: "POST",
    body: "synthetic-form",
    redirect: "error",
  });
  expect(options!.signal).toBeInstanceOf(AbortSignal);
  expect(result.body).toEqual({ access_token: "synthetic-only" });
});
