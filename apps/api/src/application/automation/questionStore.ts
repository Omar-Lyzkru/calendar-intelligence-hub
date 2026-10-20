import type { AutomationDecision } from "@prisma/client";
import type { ActionDecision, DuplicateCheck } from "@hub/contracts";
import { db } from "../../infrastructure/persistence/db.js";
import { createHash } from "node:crypto";
export function advisoryFingerprint(
  check: DuplicateCheck,
  kind: "duplicate" | "conflict",
) {
  const matches =
    kind === "duplicate" ? check.matches : check.conflicts?.matches || [];
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...matches].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      ),
    )
    .digest("hex");
}
export async function synchronizeQuestion(
  row: AutomationDecision,
  result: ActionDecision,
  checks?: DuplicateCheck,
) {
  const kind = result.decision === "ask_user" ? result.question : undefined;
  const fingerprint =
    checks && (kind === "duplicate" || kind === "conflict")
      ? advisoryFingerprint(checks, kind)
      : kind
        ? "reason:" + result.reason
        : null;
  await db.$transaction(async (tx) => {
    const existing = await tx.automationQuestion.findFirst({
      where: { decisionId: row.id, status: "open" },
    });
    if (
      kind &&
      existing?.kind === kind &&
      existing.reviewRevision === row.reviewRevision &&
      existing.policyRevision === row.policyRevision &&
      existing.sourceRevision === row.sourceRevision &&
      existing.advisoryFingerprint === fingerprint
    )
      return;
    await tx.automationQuestion.updateMany({
      where: { decisionId: row.id, status: "open" },
      data: { status: "invalidated", closedAt: new Date() },
    });
    if (kind)
      await tx.automationQuestion.create({
        data: {
          userId: row.userId,
          decisionId: row.id,
          kind,
          reviewRevision: row.reviewRevision,
          policyRevision: row.policyRevision,
          sourceRevision: row.sourceRevision,
          advisoryFingerprint: fingerprint,
        },
      });
  });
}
