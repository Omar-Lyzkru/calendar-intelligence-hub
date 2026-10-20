import { isolateProviderEnvironment } from "./tests/providerEnvironment.js";
import { defineConfig } from "@playwright/test";
isolateProviderEnvironment();
process.env.DATABASE_URL =
  "postgresql://synthetic@127.0.0.1:1/calendar_unit_test";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4173", headless: true },
  webServer: {
    command: "tsx tests/e2e/server.ts",
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: false,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL || "" },
  },
  reporter: "list",
});
