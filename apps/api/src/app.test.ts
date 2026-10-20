import { it, expect } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
it("health_returns_safe_status", async () => {
  const r = await request(createApp()).get("/api/health");
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ status: "ok" });
});
