import { Prisma } from "@prisma/client";
import { AppError } from "@hub/contracts";
import { db, json } from "./db.js";
import { redactCandidate } from "./reviews.js";
import type { EventCandidate, EventDraft } from "@hub/contracts";
async function erase(id: string, userId: string) {
  await db.$transaction(async (tx) => {
    const m = await tx.normalizedMessage.findFirst({
      where: { id, userId },
      include: { detected: { include: { review: true } } },
    });
    if (!m) throw new AppError("not_found", 404);
    await tx.normalizedMessage.update({
      where: { id },
      data: { content: null },
    });
    if (m.detected) {
      await tx.detectedEvent.update({
        where: { id: m.detected.id },
        data: {
          candidate: json(
            redactCandidate(m.detected.candidate as unknown as EventCandidate),
          ),
        },
      });
      // Serialize redaction with edits/approval and read the current draft.
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "ReviewItem" WHERE "detectedEventId"=${m.detected.id}::uuid FOR UPDATE`,
      );
      const r = await tx.reviewItem.findUnique({
        where: { detectedEventId: m.detected.id },
      });
      if (r) {
        const draft = r.draft as unknown as EventDraft;
        if (draft.temporal.kind === "unresolved")
          await tx.reviewItem.update({
            where: { id: r.id },
            data: {
              draft: json({
                ...draft,
                temporal: { ...draft.temporal, text: "" },
              }),
            },
          });
      }
    }
    await tx.historyEntry.create({
      data: { userId, messageId: id, action: "content_erased" },
    });
  });
}
export async function purgeExpiredContent(now: Date): Promise<number> {
  const expired = await db.normalizedMessage.findMany({
    where: { expiresAt: { lte: now }, content: { not: null } },
    select: { id: true, userId: true },
  });
  for (const m of expired) await erase(m.id, m.userId);
  return expired.length;
}
export async function deleteContent(
  userId: string,
  messageId: string,
): Promise<void> {
  await erase(messageId, userId);
}
