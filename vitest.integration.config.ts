import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: { "@hub/contracts": resolve("packages/contracts/src/index.ts") },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    setupFiles: ["tests/integration/setup.ts"],
  },
});
