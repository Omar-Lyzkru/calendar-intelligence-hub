// Isolated synthetic stress worker, never imported by production.
import { withActionLock } from "../../apps/api/src/application/automation/actionLock.js";
const url = process.env.TEST_DATABASE_URL;
const userId = process.argv[2];
if (
  !url ||
  !new URL(url).pathname.endsWith("_test") ||
  !/^[a-f0-9-]{36}$/.test(userId)
)
  throw Error("Invalid isolated worker setup");
process.env.DATABASE_URL = url;
process.send?.({ type: "ready" });
await withActionLock({ userId }, async () => {
  process.send?.({ type: "locked" });
  await new Promise<void>((resolve) => {
    process.on("message", (message) => {
      if (message === "release") resolve();
    });
  });
});
process.send?.({ type: "done" }, () => process.exit(0));
