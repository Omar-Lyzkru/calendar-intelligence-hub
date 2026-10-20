import { db } from "../../apps/api/src/infrastructure/persistence/db.js";
import type { NormalizedMessage } from "@hub/contracts";
export async function fixture() {
  const u = await db.user.create({
    data: {
      googleSubject: crypto.randomUUID(),
      email: "synthetic@example.test",
    },
  });
  const a = await db.googleAuthorization.create({
    data: { userId: u.id, subject: u.googleSubject, scopes: [] },
  });
  const c = await db.sourceConnection.create({
    data: {
      userId: u.id,
      authorizationId: a.id,
      externalAccountId: u.googleSubject,
    },
  });
  const message: NormalizedMessage = {
    id: crypto.randomUUID(),
    userId: u.id,
    sourceConnectionId: c.id,
    externalId: "test",
    source: "gmail",
    content: "Workshop October 8, 2026 at 2:00 PM",
    subject: "Workshop",
    receivedAt: "2026-10-07T12:00:00Z",
    ingestedAt: "2026-10-07T12:00:00Z",
    normalizationVersion: 1,
  };
  return { actor: { userId: u.id }, message, user: u, connection: c };
}
