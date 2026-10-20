import { it, expect, afterAll } from "vitest";
import { fixture } from "./helpers.js";
import { importMessages } from "../../apps/api/src/application/importMessages.js";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
const gateway = {
  list: async () => ({ messages: [] }),
  get: async (_actor: unknown, id: string) => {
    if (id === "bad") throw Error("provider secret");
    return {
      id,
      internalDate: "1791374400000",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "Workshop" }],
        body: {
          data: Buffer.from("Workshop October 8, 2026 at 2:00 PM").toString(
            "base64url",
          ),
        },
      },
    };
  },
};
afterAll(() => db.$disconnect());
it("import_rejects_more_than_20_ids", async () => {
  const f = await fixture();
  await expect(
    importMessages(f.actor, Array(21).fill("x"), gateway),
  ).rejects.toMatchObject({ status: 422 });
});
it("mixed_batch_retains_success_records_failure_and_reimport_is_stable", async () => {
  const f = await fixture();
  const r = await importMessages(f.actor, ["good", "bad"], gateway);
  expect(r.items.map((i) => i.status)).toEqual(["review", "failed"]);
  expect(r.items[1].reason).not.toContain("secret");
  const again = await importMessages(f.actor, ["good"], gateway);
  expect(again.items[0].reviewId).toBe(r.items[0].reviewId);
  expect(
    await db.processingAttempt.count({
      where: { sourceConnectionId: f.connection.id, outcome: "failed" },
    }),
  ).toBe(1);
});
it("only_selected_ids_are_fetched_and_duplicates_collapsed", async () => {
  const f = await fixture();
  const fetched: string[] = [];
  await importMessages(f.actor, ["one", "one", "two"], {
    ...gateway,
    get: async (a, id) => {
      fetched.push(id);
      return gateway.get(a, id);
    },
  });
  expect(fetched).toEqual(["one", "two"]);
});
it("missing_gmail_connection_requires_authorization", async () => {
  const f = await fixture();
  await db.sourceConnection.update({
    where: { id: f.connection.id },
    data: { status: "disconnected" },
  });
  await expect(importMessages(f.actor, ["one"], gateway)).rejects.toMatchObject(
    { code: "reauthorization_required" },
  );
});
