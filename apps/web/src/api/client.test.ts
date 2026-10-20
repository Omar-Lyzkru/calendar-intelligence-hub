import { it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { ApiError, api } from "./client.js";
afterEach(() => vi.unstubAllGlobals());
it("Microsoft rate-limit header yields bounded retry guidance without raw response text", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "microsoft_rate_limited",
            description: "synthetic private provider response",
          },
        }),
        { status: 429, headers: { "Retry-After": "120" } },
      ),
  );
  await expect(api("/api/outlook/messages", z.unknown())).rejects.toMatchObject(
    { retryAfterSeconds: 120, message: expect.stringContaining("120 seconds") },
  );
});
it("API errors preserve structured blockers but do not display an unknown code", () => {
  const e = new ApiError("PRIVATE-SENTINEL", 500, [
    {
      field: "title",
      code: "title_required",
      kind: "missing",
      message: "Enter an event title before approval.",
    },
  ]);
  expect(e.message).not.toContain("PRIVATE-SENTINEL");
  expect(e.blockers[0].code).toBe("title_required");
});
