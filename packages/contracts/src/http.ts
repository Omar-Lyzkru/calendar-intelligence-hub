import { ConfidenceReportSchema } from "./confidence.js";
import { EventCategorySchema, ClassificationSchema } from "./categories.js";
import { z } from "zod";
import {
  EditableEventDraftSchema,
  ReadyEventSchema,
  timezone,
} from "./events.js";
export const BlockerSchema = z.object({
  field: z.string(),
  code: z.string(),
  kind: z.enum(["missing", "unresolved", "invalid", "confirmation_required"]),
  message: z.string(),
});
export const RecoverySchema = z.object({
  action: z.enum([
    "none",
    "correct",
    "reconnect",
    "retry_import",
    "retry_calendar_write",
    "refresh",
    "resolve_issue",
  ]),
  canRetryNow: z.boolean(),
  message: z.string(),
});
export const ReviewStateSchema = z.object({
  workflow: z.object({ phase: z.enum(["review", "approved", "ignored"]) }),
  readiness: z.object({
    status: z.enum(["ready", "blocked"]),
    blockers: z.array(BlockerSchema),
    missingFields: z.array(z.string()),
  }),
  actions: z.object({
    edit: z.boolean(),
    ignore: z.boolean(),
    approve: z.boolean(),
    write: z.boolean(),
    refresh: z.boolean(),
  }),
  recovery: RecoverySchema,
});
export const ProcessingFailureSchema = z.object({
  stage: z.enum(["fetch", "normalize", "process", "persist", "legacy_unknown"]),
  code: z.string(),
  message: z.string(),
  recovery: RecoverySchema,
  attemptId: z.string().optional(),
  retryAfterSeconds: z.number().int().min(1).max(86400).optional(),
});
export const CandidateSchema = z.object({
  draft: EditableEventDraftSchema,
  missingFields: z.array(z.string()),
  validationIssues: z.array(z.string()),
  evidence: z.array(
    z.object({
      code: z.string(),
      origin: z.enum(["subject", "content"]).optional(),
      text: z.string().optional(),
      start: z.number().optional(),
      end: z.number().optional(),
    }),
  ),
  extractionVersion: z.number(),
  confidence: ConfidenceReportSchema.nullable(),
  classification: ClassificationSchema.optional(),
});
export const ReceiptSchema = z.object({
  providerEventId: z.string(),
  calendarId: z.string(),
  htmlLink: z
    .url()
    .refine(
      (u) =>
        new URL(u).protocol === "https:" &&
        new URL(u).hostname === "calendar.google.com",
    ),
  payloadHash: z.string(),
});
export const WriteOutcomeSchema = z.object({
  status: z.enum(["writing", "added", "failed", "unknown"]),
  receipt: ReceiptSchema.optional(),
  reason: z.string().optional(),
});
export const ReviewDetailSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  revision: z.number().int(),
  status: z.enum(["needs_review", "approved", "writing", "added", "ignored"]),
  draft: EditableEventDraftSchema,
  originalText: z.string().nullable(),
  subject: z.string().nullable(),
  candidate: CandidateSchema,
  approvedSnapshot: ReadyEventSchema.nullable(),
  write: WriteOutcomeSchema.nullable(),
  source: z
    .object({
      provider: z.enum(["gmail", "outlook", "discord", "unknown"]),
      notice: z
        .object({
          kind: z.enum(["changed", "deleted"]),
          revision: z.number().int().positive(),
          requiresConfirmation: z.boolean(),
        })
        .optional(),
      receivedAt: z.iso.datetime(),
      contentStatus: z.enum(["available", "expired_or_deleted"]),
    })
    .optional(),
  checksUnavailable: z.literal(true),
  state: ReviewStateSchema.optional(),
});
export const MeSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), timezone }).nullable(),
  csrf: z.string(),
});
export const ConnectionSchema = z.object({
  status: z.string(),
  scopes: z.array(z.string()),
});
export const MicrosoftConnectionSchema = z.object({
  configured: z.boolean(),
  status: z.enum([
    "connected",
    "disconnected",
    "reauthorization_required",
    "blocked",
  ]),
});
export const MessagePageSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      subject: z.string(),
      sender: z.string(),
      snippet: z.string(),
      receivedAt: z.iso.datetime().optional(),
    }),
  ),
  nextPageToken: z.string().optional(),
});
export const ImportBatchSchema = z.object({
  items: z.array(
    z.object({
      externalId: z.string(),
      status: z.enum(["review", "no_event", "failed"]),
      reviewId: z.string().optional(),
      reason: z.string().optional(),
      state: ReviewStateSchema.optional(),
      processingFailure: ProcessingFailureSchema.optional(),
    }),
  ),
});
export const ReviewPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      category: z.string(),
      eventCategory: EventCategorySchema.optional(),
      state: ReviewStateSchema.optional(),
      write: WriteOutcomeSchema.nullable().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const HistoryPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      reason: z.string().nullable(),
      actor: z.string(),
      createdAt: z.string(),
      reviewId: z.string().nullable(),
      label: z.string().optional(),
      message: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const DiscordConnectionSchema = z.object({
  configured: z.boolean(),
  status: z.enum(["connected", "disconnected"]),
  runtime: z.object({
    state: z.enum(["idle", "connecting", "connected", "blocked"]),
    coverage: z.enum(["not_checked", "capped", "incomplete"]),
    reason: z.string().optional(),
    retryAfterSeconds: z.number().int().min(1).max(86400).optional(),
  }),
});
export const DiscordMessagePageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(["review", "no_event"]),
      reviewId: z.string().optional(),
      receivedAt: z.iso.datetime(),
    }),
  ),
  failures: z.array(z.object({ id: z.string(), reason: z.string() })),
  nextPageToken: z.string().optional(),
});
