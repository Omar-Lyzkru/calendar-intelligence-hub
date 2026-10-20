import { it, expect } from "vitest";
import { loadConfig } from "./env.js";
it("config_rejects_missing_production_secrets", () => {
  expect(() => loadConfig({ NODE_ENV: "production" })).toThrow();
});
const base = {
  APP_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgresql://synthetic@localhost/hub_test",
  GOOGLE_CLIENT_ID: "synthetic",
  GOOGLE_CLIENT_SECRET: "synthetic",
  GOOGLE_REDIRECT_URI: "http://localhost:5173/auth/google/callback",
  TOKEN_ENCRYPTION_KEY: "1".repeat(64),
};
const microsoft = {
  MICROSOFT_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
  MICROSOFT_TENANT_ID: "22222222-2222-4222-8222-222222222222",
  MICROSOFT_CLIENT_SECRET: "synthetic-only",
  MICROSOFT_REDIRECT_URI: "http://localhost:5173/auth/microsoft/callback",
};
it("Google-only config remains valid with empty Microsoft placeholders", () => {
  expect(
    loadConfig({ ...base, MICROSOFT_CLIENT_ID: "" }).GOOGLE_CLIENT_ID,
  ).toBe("synthetic");
});
it("configured Microsoft Web callback is retained backend-side", () => {
  expect(loadConfig({ ...base, ...microsoft }).MICROSOFT_REDIRECT_URI).toBe(
    "http://localhost:5173/auth/microsoft/callback",
  );
});
it.each([
  { MICROSOFT_CLIENT_ID: microsoft.MICROSOFT_CLIENT_ID },
  { ...microsoft, MICROSOFT_TENANT_ID: "organizations" },
  { ...microsoft, MICROSOFT_CLIENT_ID: "not-a-guid" },
  { ...microsoft, MICROSOFT_CLIENT_SECRET: "" },
  {
    ...microsoft,
    MICROSOFT_REDIRECT_URI: "http://other.example.test/auth/microsoft/callback",
  },
  { ...microsoft, MICROSOFT_REDIRECT_URI: "http://localhost:5173/wrong" },
  {
    ...microsoft,
    MICROSOFT_REDIRECT_URI:
      "http://localhost:5173/auth/microsoft/callback?extra=1",
  },
])(
  "rejects partial, broad-tenant or inconsistent Microsoft configuration %#",
  (input) => {
    expect(() => loadConfig({ ...base, ...input })).toThrow();
  },
);
