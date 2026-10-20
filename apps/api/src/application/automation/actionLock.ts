import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import { AppError, type Actor } from "@hub/contracts";
// Separate pool: queued lock holders must not exhaust Prisma's connections.
let pool: Pool | undefined;
const context = new AsyncLocalStorage<Map<string, PoolClient>>();
export async function withScopedLock<T>(
  scope: string,
  work: () => Promise<T>,
  tryOnly = false,
): Promise<T | undefined> {
  if (context.getStore()?.has(scope)) return work();
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 5000,
    });
    pool.on("error", () =>
      console.error(JSON.stringify({ code: "automation_lock_unavailable" })),
    );
  }
  const client = await pool.connect();
  // pg surfaces connection loss; never print raw database/transport errors.
  const onError = () => {};
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '120s'");
    if (tryOnly) {
      const r = await client.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [scope],
      );
      if (!r.rows[0].acquired) return undefined;
    } else
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [scope],
      );
    const state = new Map(context.getStore() || []);
    state.set(scope, client);
    return await context.run(state, work);
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* dead connection already released its server-side lock */
    }
    client.removeListener("error", onError);
    client.release();
  }
}
export async function withActionLock<T>(
  actor: Actor,
  work: () => Promise<T>,
): Promise<T> {
  return (await withScopedLock("calendar-actions:" + actor.userId, work))!;
}
export async function assertActionLock(actor: Actor) {
  const client = context.getStore()?.get("calendar-actions:" + actor.userId);
  if (!client) throw new AppError("record_integrity_error", 409);
  try {
    await client.query("SELECT 1");
  } catch {
    throw new AppError("provider_unavailable", 503);
  }
}
