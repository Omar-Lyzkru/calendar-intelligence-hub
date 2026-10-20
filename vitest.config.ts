import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: { "@hub/contracts": resolve("packages/contracts/src/index.ts") },
  },
  test: {
    setupFiles: ["tests/unitSetup.ts"],
    include: [
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "packages/**/*.test.ts",
    ],
    fileParallelism: false,
  },
});
