import { it, expect, afterAll } from "vitest";
import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import { fixture } from "./helpers.js";
afterAll(() => db.$disconnect());
it("additive automation schema has no enabled policy or historical enrollment for existing users", async () => {
  const f = await fixture();
  const tables = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
  expect(tables.map((t) => t.tablename)).toEqual(
    expect.arrayContaining([
      "AutomationPolicy",
      "AutomationDecision",
      "AutomationQuestion",
      "IngestionPoll",
    ]),
  );
  expect(await db.user.findUnique({ where: { id: f.user.id } })).toMatchObject({
    id: f.user.id,
  });
  const policies = await db.$queryRaw<
    Array<{ enabled: boolean }>
  >`SELECT enabled FROM "AutomationPolicy" WHERE "userId"=${f.user.id}::uuid`;
  expect(policies).toEqual([]);
});

import { Client } from "pg";
import { readFileSync } from "node:fs";
it("automation SQL upgrade preserves existing provider credentials, sources, approval payloads and history", async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");
  try {
    const schema = "discord_upgrade_" + crypto.randomUUID().replaceAll("-", "");
    await client.query('CREATE SCHEMA "' + schema + '"');
    await client.query('SET LOCAL search_path TO "' + schema + '"');
    for (const name of [
      "20261007203421_initial",
      "20261012185000_outlook_authorization",
      "20261012190000_microsoft_oauth_generation",
      "20261013220000_discord_relay",
    ])
      await client.query(
        readFileSync("prisma/migrations/" + name + "/migration.sql", "utf8"),
      );
    const [u, g, m, c1, c2, n, d, r, w, h] = Array.from({ length: 10 }, () =>
      crypto.randomUUID(),
    );
    await client.query(
      'INSERT INTO "User" (id,"googleSubject",email) VALUES ($1,$2,$3)',
      [u, "synthetic", "synthetic@example.test"],
    );
    await client.query(
      'INSERT INTO "GoogleAuthorization" (id,"userId",subject,"refreshToken",scopes) VALUES ($1,$2,$3,$4,$5)',
      [g, u, "synthetic", "synthetic-encrypted", ["gmail.readonly"]],
    );
    await client.query(
      'INSERT INTO "MicrosoftAuthorization" (id,"userId","tenantId","accountId","tokenCache",scopes) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        m,
        u,
        "synthetic-tenant",
        "synthetic-account",
        "synthetic-encrypted-cache",
        ["Mail.Read"],
      ],
    );
    await client.query(
      'INSERT INTO "SourceConnection" (id,"userId","authorizationId","externalAccountId") VALUES ($1,$2,$3,$4)',
      [c1, u, g, "synthetic"],
    );
    await client.query(
      'INSERT INTO "SourceConnection" (id,"userId",provider,"microsoftAuthorizationId","externalAccountId") VALUES ($1,$2,$3,$4,$5)',
      [c2, u, "outlook", m, "synthetic-account"],
    );
    await client.query(
      'INSERT INTO "NormalizedMessage" (id,"userId","sourceConnectionId","externalId",source,content,"receivedAt","ingestedAt","expiresAt",metadata,"normalizationVersion",status) VALUES ($1,$2,$3,$4,$5,$6,now(),now(),now()+interval \'30 days\',$7,1,$8)',
      [n, u, c2, "existing", "outlook", "Synthetic content", {}, "review"],
    );
    await client.query(
      'INSERT INTO "DetectedEvent" (id,"messageId",candidate) VALUES ($1,$2,$3)',
      [d, n, { synthetic: "candidate" }],
    );
    await client.query(
      'INSERT INTO "ReviewItem" (id,"userId","detectedEventId",draft,status,"approvedSnapshot","approvedAt") VALUES ($1,$2,$3,$4,$5,$6,now())',
      [r, u, d, { synthetic: "draft" }, "added", { synthetic: "snapshot" }],
    );
    await client.query(
      'INSERT INTO "CalendarEvent" (id,"reviewItemId","providerEventId",payload,"payloadHash",state,"leaseUntil","claimToken",receipt) VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8)',
      [
        w,
        r,
        "synthetic-provider-id",
        { synthetic: "payload" },
        "synthetic-immutable-hash",
        "added",
        "synthetic-claim",
        { synthetic: "receipt" },
      ],
    );
    await client.query(
      'INSERT INTO "HistoryEntry" (id,"userId","reviewId",action) VALUES ($1,$2,$3,$4)',
      [h, u, r, "calendar_write_added"],
    );
    const tables = [
      "GoogleAuthorization",
      "MicrosoftAuthorization",
      "NormalizedMessage",
      "DetectedEvent",
      "ReviewItem",
      "CalendarEvent",
      "HistoryEntry",
    ];
    const before = [];
    for (const t of tables)
      before.push(
        await client.query('SELECT row_to_json(t) FROM "' + t + '" t'),
      );
    const sources = await client.query(
      'SELECT id,provider,"authorizationId","microsoftAuthorizationId",status FROM "SourceConnection" ORDER BY id',
    );
    await client.query(
      readFileSync(
        "prisma/migrations/20261014210000_automation/migration.sql",
        "utf8",
      ),
    );
    for (let i = 0; i < tables.length; i++)
      expect(
        (await client.query('SELECT row_to_json(t) FROM "' + tables[i] + '" t'))
          .rows,
      ).toEqual(before[i].rows);
    expect(
      (
        await client.query(
          'SELECT id,provider,"authorizationId","microsoftAuthorizationId",status FROM "SourceConnection" ORDER BY id',
        )
      ).rows,
    ).toEqual(sources.rows);
    expect(
      (await client.query('SELECT count(*) FROM "AutomationDecision"')).rows[0]
        .count,
    ).toBe("0");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
