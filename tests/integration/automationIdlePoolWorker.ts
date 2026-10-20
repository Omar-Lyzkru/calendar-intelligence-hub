// Synthetic process disconnect/reconnect regression. Never imported by production.
import {
  withScopedLock,
  withActionLock,
  assertActionLock,
} from "../../apps/api/src/application/automation/actionLock.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Invalid isolated worker setup");
process.env.DATABASE_URL = url;
const actor = { userId: crypto.randomUUID() };
if (process.argv[2] === "active") {
  try {
    await withActionLock(actor, async () => {
      process.send?.("ready");
      await new Promise<void>((resolve) =>
        process.once("message", () => resolve()),
      );
      await assertActionLock(actor);
      process.send?.("unsafe");
    });
  } catch {
    process.send?.("blocked");
  }
  await withActionLock(actor, () => assertActionLock(actor));
  process.send?.("reacquired", () => process.exit(0));
} else {
  await withScopedLock("synthetic-idle-pool", async () => {});
  process.send?.("ready");
  setTimeout(async () => {
    try {
      await withScopedLock("synthetic-idle-pool", async () => {});
      process.send?.("reacquired", () => process.exit(0));
    } catch {
      process.exit(2);
    }
  }, 500);
}
