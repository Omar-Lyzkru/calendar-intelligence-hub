import type { Prisma } from "@prisma/client";
import {
  EditableEventDraftSchema,
  ReadyEventSchema,
  ReceiptSchema,
  evaluateDraft,
  type CalendarReceipt,
  hasReviewIntegrity,
  type Actor,
  type DuplicateRecord,
  type DuplicateCoverage,
  type DuplicateWindow,
  type ReviewDetail,
  type CalendarWriteOutcome,
} from "@hub/contracts";
import { db } from "./db.js";
import { payloadHash } from "../google/calendar.js";
export function duplicateAssociation(
  snapshot: unknown,
  write: {
    state: string;
    calendarId: string;
    providerEventId: string;
    payloadHash: string;
    receipt: unknown;
  } | null,
): { valid: boolean; hash?: string; receipt?: CalendarReceipt } {
  if (!write) return { valid: true };
  try {
    const event = ReadyEventSchema.parse(snapshot);
    const hash = payloadHash(event);
    if (write.calendarId !== "primary" || write.payloadHash !== hash)
      return { valid: false };
    if (write.state !== "added") return { valid: true, hash };
    const receipt = ReceiptSchema.parse(write.receipt);
    if (
      receipt.providerEventId !== write.providerEventId ||
      receipt.calendarId !== write.calendarId ||
      receipt.payloadHash !== hash
    )
      return { valid: false };
    return { valid: true, hash, receipt };
  } catch {
    return { valid: false };
  }
}

type Identity = { connectionId: string; externalId: string };
function temporalFilter(
  field: "draft" | "approvedSnapshot",
  w: DuplicateWindow,
): Prisma.ReviewItemWhereInput {
  const json = (path: string[], filter: Record<string, string>) =>
    ({ [field]: { path, ...filter } }) as Prisma.ReviewItemWhereInput;
  return {
    OR: [
      {
        AND: [
          json(["temporal", "kind"], { equals: "timed" }),
          json(["temporal", "start"], { lte: w.timeMax }),
          {
            OR: [
              json(["temporal", "start"], { gte: w.timeMin }),
              json(["temporal", "end"], { gte: w.timeMin }),
            ],
          },
        ],
      },
      ...["all_day", "date_only"].map((kind) => ({
        AND: [
          json(["temporal", "kind"], { equals: kind }),
          json(["temporal", "startDate"], { lte: w.dateMax }),
          {
            OR: [
              json(["temporal", "startDate"], { gte: w.dateMin }),
              json(
                [
                  "temporal",
                  kind === "all_day" ? "endExclusive" : "endDateInclusive",
                ],
                { gte: w.dateMin },
              ),
            ],
          },
        ],
      })),
    ],
  };
}
export async function localDuplicateRecords(
  actor: Actor,
  currentId: string,
  window: DuplicateWindow,
  identity: Identity,
): Promise<{ events: DuplicateRecord[]; coverage: DuplicateCoverage }> {
  const rows = await db.reviewItem.findMany({
    where: {
      userId: actor.userId,
      id: { not: currentId },
      status: { in: ["needs_review", "approved", "writing", "added"] },
      OR: [
        temporalFilter("draft", window),
        temporalFilter("approvedSnapshot", window),
        {
          detectedEvent: {
            message: {
              sourceConnectionId: identity.connectionId,
              externalId: identity.externalId,
            },
          },
        },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 201,
    select: {
      id: true,
      userId: true,
      status: true,
      draft: true,
      approvedSnapshot: true,
      detectedEvent: {
        select: {
          message: {
            select: {
              userId: true,
              sourceConnectionId: true,
              externalId: true,
              connection: { select: { userId: true } },
            },
          },
        },
      },
      write: {
        select: {
          state: true,
          calendarId: true,
          providerEventId: true,
          payloadHash: true,
          receipt: true,
        },
      },
    },
  });
  let partial = rows.length > 200;
  const events: DuplicateRecord[] = [];
  for (const r of rows.slice(0, 200)) {
    const m = r.detectedEvent.message;
    const parsed = r.approvedSnapshot
      ? ReadyEventSchema.safeParse(r.approvedSnapshot)
      : EditableEventDraftSchema.safeParse(r.draft);
    if (
      m.userId !== actor.userId ||
      m.connection.userId !== actor.userId ||
      !parsed.success ||
      !hasReviewIntegrity(
        r.status as ReviewDetail["status"],
        !!r.approvedSnapshot,
        r.write
          ? {
              status: r.write.state as CalendarWriteOutcome["status"],
              receipt: r.write
                .receipt as unknown as CalendarWriteOutcome["receipt"],
            }
          : null,
      )
    ) {
      partial = true;
      continue;
    }
    const e = parsed.data;
    const evaluation = evaluateDraft(e, { legacyTitle: !!r.approvedSnapshot });
    const association = duplicateAssociation(r.approvedSnapshot, r.write);
    if (
      !association.valid ||
      (evaluation.status === "blocked" &&
        evaluation.blockers.some((b) => b.kind === "invalid"))
    ) {
      partial = true;
      continue;
    }
    events.push({
      key: "local:" + r.id,
      source: "local",
      commitment: !!r.approvedSnapshot,
      availability: "busy",
      reviewId: r.id,
      title: e.title,
      location: e.location,
      temporal: e.temporal,
      sourceIdentity: {
        connectionId: m.sourceConnectionId,
        externalId: m.externalId,
      },
      ...(association.hash ? { payloadHash: association.hash } : {}),
      ...(association.receipt
        ? {
            calendarId: "primary" as const,
            providerEventId: association.receipt.providerEventId,
            htmlLink: association.receipt.htmlLink,
          }
        : {}),
    });
  }
  return {
    events,
    coverage: partial
      ? {
          status: "partial",
          reason: rows.length > 200 ? "limit_reached" : "unsupported_events",
        }
      : { status: "checked" },
  };
}
