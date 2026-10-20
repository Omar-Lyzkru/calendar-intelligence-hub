import { duplicateAssociation } from "../../infrastructure/persistence/duplicates.js";
import { advisoryFingerprint, synchronizeQuestion } from "./questionStore.js";
import {
  AppError,
  evaluateAutomation,
  applicableAutomationRule,
  ReadyEventSchema,
  AutomationDecisionSchema,
  type Actor,
  type ActionDecision,
  type DuplicateCheck,
  type ReviewDetail,
} from "@hub/contracts";
import { db, json } from "../../infrastructure/persistence/db.js";
import { getReview } from "../../infrastructure/persistence/reviews.js";
import { getPolicy } from "./policyStore.js";
import { withActionLock, assertActionLock } from "./actionLock.js";
import { checkDuplicates } from "../checkDuplicates.js";
import { approveAutomatically } from "../approveReview.js";
import { createCalendarEvent } from "../createCalendarEvent.js";
import {
  payloadHash,
  type CalendarGateway,
} from "../../infrastructure/google/calendar.js";
export interface AutomationOptions {
  allowWrites?: boolean;
}
export async function evaluateReview(
  actor: Actor,
  id: string,
  calendar: CalendarGateway,
  options: AutomationOptions = {},
) {
  return withActionLock(actor, async () => {
    let detail = await getReview(actor, id);
    const message = await db.normalizedMessage.findFirstOrThrow({
      where: { id: detail.messageId, userId: actor.userId },
      include: { connection: true, observation: true },
    });
    const policy = await getPolicy(actor);
    let previous = await db.automationDecision.findUnique({
      where: { reviewId: id },
    });
    const sourceRevision = message.observation?.sourceRevision || 1;
    const confirmationCurrent =
      previous?.confirmedRevision === detail.revision &&
      previous.policyRevision === policy.revision &&
      previous.sourceRevision === sourceRevision;
    const source = {
      connectionId: message.sourceConnectionId,
      channelId: message.observation?.channelId,
      connected: message.connection.status === "connected",
      eligible:
        !!policy.enabledAt &&
        message.ingestedAt >= policy.enabledAt &&
        message.receivedAt >= policy.enabledAt,
    };
    const autoOwned =
      (previous?.evidence as { autoApproved?: boolean } | undefined)
        ?.autoApproved === true;
    let result: ActionDecision;
    let checks: DuplicateCheck | undefined;
    let terminalReceiptValid = true;
    if (detail.status === "added") {
      const write = await db.calendarEvent.findUnique({
        where: { reviewItemId: id },
      });
      const association = duplicateAssociation(detail.approvedSnapshot, write);
      terminalReceiptValid = association.valid && !!association.receipt;
      if (terminalReceiptValid && autoOwned && previous?.reason === "added")
        return { decision: "auto_handle" as const, reason: "added" as const };
    }
    const ctx = {
      policy,
      review: detail,
      source,
      confirmedFields: confirmationCurrent ? previous!.confirmedFields : [],
    };
    if (["approved", "writing"].includes(detail.status) && !autoOwned)
      result = { decision: "blocked", reason: "manual_state" };
    else if (detail.status === "added" && !terminalReceiptValid)
      result = { decision: "blocked", reason: "record_problem" };
    else if (detail.status === "added")
      result = autoOwned
        ? { decision: "auto_handle", reason: "added" }
        : { decision: "skip", reason: "already_added" };
    else result = evaluateAutomation(ctx);
    if (result.reason === "checks_unavailable") {
      try {
        checks = await checkDuplicates(actor, id, detail.revision, calendar);
      } catch (error) {
        result = {
          decision: "blocked",
          reason:
            error instanceof AppError && error.code === "stale_review"
              ? "stale"
              : "checks_unavailable",
        };
      }
      if (checks) {
        result = evaluateAutomation({
          ...ctx,
          checks,
          duplicateAccepted:
            confirmationCurrent &&
            previous?.duplicateFingerprint ===
              advisoryFingerprint(checks, "duplicate"),
          conflictAccepted:
            confirmationCurrent &&
            previous?.conflictFingerprint ===
              advisoryFingerprint(checks, "conflict"),
        });
        const after = await getReview(actor, id);
        const currentPolicy = await getPolicy(actor);
        const currentMessage = await db.normalizedMessage.findUniqueOrThrow({
          where: { id: message.id },
          include: { connection: true, observation: true },
        });
        if (
          currentPolicy.revision !== policy.revision ||
          after.revision !== detail.revision ||
          after.status !== detail.status ||
          (currentMessage.observation?.sourceRevision || 1) !== sourceRevision
        )
          result = { decision: "blocked", reason: "stale" };
        else if (currentMessage.connection.status !== "connected")
          result = { decision: "blocked", reason: "source_unavailable" };
        else
          result = evaluateAutomation({
            ...ctx,
            review: after,
            checks,
            duplicateAccepted:
              confirmationCurrent &&
              previous?.duplicateFingerprint ===
                advisoryFingerprint(checks, "duplicate"),
            conflictAccepted:
              confirmationCurrent &&
              previous?.conflictFingerprint ===
                advisoryFingerprint(checks, "conflict"),
          });
      }
    }
    const evidence =
      detail.status === "added" && previous
        ? (previous.evidence as Record<string, unknown>)
        : {
            ...(result.question === "duplicate" ||
            result.question === "conflict"
              ? {
                  advisories:
                    (result.question === "duplicate"
                      ? checks?.matches
                      : checks?.conflicts?.matches
                    )
                      ?.slice(0, 5)
                      .map((match) => ({
                        title: match.facts.title,
                        temporal: match.facts.temporal,
                      })) || [],
                }
              : {}),
            confirmedFacts: ctx.confirmedFields,
            rule: applicableAutomationRule(
              policy,
              source,
              detail.draft.eventCategory,
            ),
            category: detail.draft.eventCategory || "other",
            provider: message.source,
            policyRevision: policy.revision,
            reviewRevision: detail.revision,
            sourceRevision,
            approvalMode:
              result.reason === "user_authorized"
                ? "user_confirmed"
                : "automatic",
            autoApproved: autoOwned,
            checkedAt: checks?.checkedAt || null,
            readyHash: ["eligible", "user_authorized"].includes(result.reason)
              ? payloadHash(ReadyEventSchema.parse(detail.draft))
              : null,
            duplicateCoverage: checks
              ? { local: checks.local.status, google: checks.google.status }
              : null,
            conflictCoverage: checks?.conflicts
              ? {
                  local: checks.conflicts.local.status,
                  google: checks.conflicts.google.status,
                }
              : null,
          };
    const persist = async (outcome: ActionDecision) => {
      const old = await db.automationDecision.findUnique({
        where: { reviewId: id },
      });
      const row = await db.automationDecision.upsert({
        where: { messageId: message.id },
        create: {
          userId: actor.userId,
          messageId: message.id,
          reviewId: id,
          reviewRevision: detail.revision,
          policyRevision: policy.revision,
          sourceRevision,
          decision: outcome.decision,
          reason: outcome.reason,
          evidence: json(evidence),
        },
        update: {
          // Never rebind old consent to a newer decision version.
          ...(!confirmationCurrent
            ? {
                confirmedFields: [],
                confirmedRevision: null,
                duplicateFingerprint: null,
                conflictFingerprint: null,
              }
            : {}),
          reviewRevision: detail.revision,
          policyRevision: policy.revision,
          sourceRevision,
          decision: outcome.decision,
          reason: outcome.reason,
          evidence: json(evidence),
        },
      });
      if (
        !old ||
        old.reason !== outcome.reason ||
        old.reviewRevision !== detail.revision ||
        old.policyRevision !== policy.revision
      )
        await db.historyEntry.create({
          data: {
            userId: actor.userId,
            reviewId: id,
            action:
              evidence.approvalMode === "user_confirmed" &&
              outcome.reason === "added"
                ? "automation_user_confirmed"
                : "automation_" + outcome.decision,
            reason: outcome.reason,
            actor: "automation",
          },
        });
      await synchronizeQuestion(row, outcome, checks);
      previous = row;
      return row;
    };
    if (
      ["eligible", "user_authorized"].includes(result.reason) &&
      !options.allowWrites
    )
      result = { decision: "blocked", reason: "live_acceptance_required" };
    let row = await persist(result);
    if (["eligible", "user_authorized"].includes(result.reason)) {
      await assertActionLock(actor);
      if (detail.status === "needs_review") {
        try {
          detail = await approveAutomatically(actor, id, detail.revision, {
            decisionId: row.id,
            policyRevision: policy.revision,
          });
          evidence.autoApproved = true;
        } catch (error) {
          result = {
            decision: "blocked",
            reason:
              error instanceof AppError && error.code === "stale_review"
                ? "stale"
                : "action_failed",
          };
          await persist(result);
          return AutomationDecisionSchema.parse(result);
        }
      }
      const latestPolicy = await getPolicy(actor);
      if (latestPolicy.revision !== policy.revision || !latestPolicy.enabled) {
        result = { decision: "blocked", reason: "stale" };
        await persist(result);
        return result;
      }
      const outcome = await createCalendarEvent(actor, id, calendar);
      result = {
        decision: outcome.status === "added" ? "auto_handle" : "blocked",
        reason:
          outcome.status === "added"
            ? "added"
            : outcome.status === "unknown"
              ? "action_unknown"
              : outcome.status === "writing"
                ? "action_pending"
                : "action_failed",
      };
      await persist(result);
    }
    return AutomationDecisionSchema.parse(result);
  });
}
