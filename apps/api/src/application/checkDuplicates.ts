import {
  AppError,
  hasReviewIntegrity,
  DuplicateCheckSchema,
  EditableEventDraftSchema,
  ReadyEventSchema,
  compareDuplicate,
  duplicateWindow,
  mergeDuplicateMatches,
  collectConflicts,
  conflictTemporalReady,
  type Actor,
  type EventDraft,
  type DuplicateCheck,
  type DuplicateRecord,
  type DuplicateCoverage,
} from "@hub/contracts";
import { getReview } from "../infrastructure/persistence/reviews.js";
import { db } from "../infrastructure/persistence/db.js";
import {
  duplicateAssociation,
  localDuplicateRecords,
} from "../infrastructure/persistence/duplicates.js";
import {
  payloadHash,
  type CalendarGateway,
} from "../infrastructure/google/calendar.js";
export async function checkDuplicates(
  actor: Actor,
  id: string,
  revision: number,
  gateway: CalendarGateway,
  preview?: EventDraft,
): Promise<DuplicateCheck> {
  const detail = await getReview(actor, id);
  if (detail.revision !== revision) throw new AppError("stale_review", 409);
  if (
    !hasReviewIntegrity(
      detail.status,
      !!detail.approvedSnapshot,
      detail.write,
    ) ||
    (detail.state?.recovery.action === "resolve_issue" &&
      !detail.source?.notice?.requiresConfirmation)
  )
    throw new AppError("record_integrity_error", 409);
  if (
    detail.status === "ignored" ||
    (preview && detail.status !== "needs_review")
  )
    throw new AppError("review_locked", 409);
  const current = await db.reviewItem.findFirstOrThrow({
    where: { id, userId: actor.userId },
    select: {
      write: true,
      detectedEvent: {
        select: {
          message: { select: { sourceConnectionId: true, externalId: true } },
        },
      },
    },
  });
  const user = await db.user.findUniqueOrThrow({
    where: { id: actor.userId },
    select: { timezone: true },
  });
  const draft = EditableEventDraftSchema.parse(
    detail.approvedSnapshot || preview || detail.draft,
  );
  const identity = {
    connectionId: current.detectedEvent.message.sourceConnectionId,
    externalId: current.detectedEvent.message.externalId,
  };
  const ready = ReadyEventSchema.safeParse(draft);
  const association = duplicateAssociation(
    detail.approvedSnapshot,
    current.write,
  );
  if (!association.valid) throw new AppError("record_integrity_error", 409);
  const candidate: DuplicateRecord = {
    key: "candidate:" + id,
    source: "local",
    title: draft.title,
    location: draft.location,
    temporal: draft.temporal,
    sourceIdentity: identity,
    ...(ready.success ? { payloadHash: payloadHash(ready.data) } : {}),
    ...(association.receipt
      ? {
          providerEventId: association.receipt.providerEventId,
          calendarId: "primary" as const,
        }
      : {}),
  };
  const window = duplicateWindow(draft, user.timezone);
  let local: DuplicateCoverage = {
    status: "skipped",
    reason: "unresolved_time",
  };
  let google: DuplicateCoverage = {
    status: "skipped",
    reason: "unresolved_time",
  };
  let records: DuplicateRecord[] = [];
  if (detail.status === "added") {
    const receipt = association.receipt;
    if (!receipt) throw new AppError("record_integrity_error", 409);
    records = [
      {
        ...candidate,
        key: "local:" + id,
        reviewId: id,
        htmlLink: receipt.htmlLink,
      },
    ];
    local = { status: "checked" };
    google = { status: "skipped", reason: "already_added" };
  } else if (window) {
    try {
      const result = await localDuplicateRecords(actor, id, window, identity);
      records = result.events;
      local = result.coverage;
    } catch {
      local = { status: "unavailable", reason: "local_unavailable" };
    }
    // Identity protection stays in import/write services; advisory lookup has no mutation capability.
    if (gateway.list) {
      try {
        const result = await gateway.list(actor, window);
        // This review's validated immutable intent is reconciled by GET/hash in
        // the shared writer. Its own provider-visible event is not a new match.
        records.push(
          ...result.events.filter(
            (record) =>
              !(
                current.write &&
                association.valid &&
                record.source === "google" &&
                record.calendarId === current.write.calendarId &&
                record.providerEventId === current.write.providerEventId
              ),
          ),
        );
        google = result.coverage;
      } catch (error) {
        google = {
          status: "unavailable",
          reason:
            error instanceof AppError &&
            error.code === "reauthorization_required"
              ? "reauthorization_required"
              : "provider_unavailable",
        };
      }
    } else google = { status: "unavailable", reason: "provider_unavailable" };
  }
  const matches = mergeDuplicateMatches(
    records.flatMap((record) => {
      const match = compareDuplicate(candidate, record);
      return match ? [match] : [];
    }),
  );
  const conflictReady =
    !!window &&
    conflictTemporalReady(draft.temporal) &&
    detail.status !== "added";
  const conflictResult = conflictReady
    ? collectConflicts(candidate, records, user.timezone)
    : { matches: [], unsupportedSources: [] as ("local" | "google")[] };
  const conflictCoverage = (source: "local" | "google"): DuplicateCoverage => {
    if (!conflictReady)
      return {
        status: "skipped",
        reason: detail.status === "added" ? "already_added" : "unresolved_time",
      };
    const coverage = source === "local" ? local : google;
    if (
      coverage.status === "checked" &&
      conflictResult.unsupportedSources.includes(source)
    )
      return { status: "partial", reason: "unsupported_events" };
    return coverage;
  };
  const conflicts = {
    timezone: user.timezone,
    local: conflictCoverage("local"),
    google: conflictCoverage("google"),
    matches: conflictResult.matches.slice(0, 20),
    truncated: conflictResult.matches.length > 20,
  };
  const after = await getReview(actor, id);
  if (after.revision !== revision || after.status !== detail.status)
    throw new AppError("stale_review", 409);
  return DuplicateCheckSchema.parse({
    reviewId: id,
    revision,
    checkedAt: new Date().toISOString(),
    window,
    local,
    google,
    conflicts,
    matches: matches.slice(0, 20),
    truncated: matches.length > 20,
  });
}
