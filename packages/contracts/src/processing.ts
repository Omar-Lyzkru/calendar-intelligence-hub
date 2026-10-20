import {
  AUTOMATION_REASON_LABELS,
  type AutomationReason,
} from "./automationReasons.js";
export type ProcessingStage =
  "fetch" | "normalize" | "process" | "persist" | "legacy_unknown";
export interface Recovery {
  action:
    | "none"
    | "correct"
    | "reconnect"
    | "retry_import"
    | "retry_calendar_write"
    | "refresh"
    | "resolve_issue";
  canRetryNow: boolean;
  message: string;
}
export interface ProcessingFailure {
  stage: ProcessingStage;
  code: string;
  message: string;
  recovery: Recovery;
  attemptId?: string;
  retryAfterSeconds?: number;
}
const messages: Record<string, string> = {
  discord_not_configured:
    "Discord feed setup is incomplete in this installation.",
  discord_relay_owned:
    "This Discord feed is already assigned to another workspace.",
  discord_content_intent_required:
    "Enable Message Content Intent for the Discord bot.",
  discord_intent_required:
    "Discord did not allow the required Message Content Intent.",
  discord_permissions_excessive:
    "Restrict the bot to viewing the feed and reading its history before connecting.",
  discord_permissions_required:
    "Allow the bot to view the selected feed and read its message history.",
  discord_source_missing: "The configured Discord feed is unavailable.",
  discord_token_invalid:
    "Check the local Discord bot setup before reconnecting.",
  discord_rate_limited: "Discord requested a pause. Wait before reconnecting.",
  discord_unavailable: "Discord is unavailable. Try reconnecting later.",
  discord_session_unavailable:
    "The Discord connection could not be established. Check setup before reconnecting.",
  discord_reconnect_exhausted:
    "Discord could not reconnect after repeated attempts. Reconnect when the service is available.",
  discord_queue_overflow:
    "The Discord feed exceeded the processing queue. Recent recovery is limited; some announcements may be missing.",
  discord_invalid_payload: "The Discord announcement could not be read safely.",
  discord_unsupported_content:
    "This announcement has no supported readable text. Attachments are not processed.",
  discord_invalid_source:
    "This announcement does not match the selected Follow feed.",
  discord_source_deleted:
    "The original announcement was deleted. No cancellation or Calendar change was inferred.",
  source_confirmation_required:
    "Check the latest Discord announcement and confirm your decision before proceeding.",
  microsoft_rate_limited: "Microsoft requested a pause. Wait before retrying.",
  invalid_page_token:
    "This message page expired or changed. Reload the first page.",
  microsoft_not_configured:
    "Outlook is unavailable until local Microsoft setup is complete.",
  microsoft_consent_denied:
    "Microsoft access was not granted. Your other connections are unchanged.",
  microsoft_connection_blocked:
    "Microsoft access is blocked or unavailable. Check your school’s app-consent policy with its administrator.",
  microsoft_unavailable:
    "Microsoft is temporarily unavailable. Try again later.",
  microsoft_reauthorization_required: "Reconnect Outlook before trying again.",
  microsoft_scope_not_granted:
    "The required Microsoft mail-read permission was not granted.",
  microsoft_offline_access_required:
    "Microsoft did not supply refresh access. Reconnect Outlook after checking the application setup.",
  gmail_fetch_unavailable: "Google could not retrieve the selected message.",
  gmail_list_unavailable: "Google could not list messages.",
  provider_unavailable: "Google is temporarily unavailable.",
  provider_timeout: "The provider did not respond in time.",
  provider_rate_limited: "Google requested a pause. Wait before retrying.",
  reauthorization_required: "Reconnect Google access before trying again.",
  invalid_provider_payload: "The message response could not be read safely.",
  provider_id_mismatch: "The response did not match the selected message.",
  invalid_body_encoding: "The message encoding is unsupported.",
  invalid_received_date: "The message timestamp is invalid.",
  message_too_large: "The message exceeds the supported size.",
  message_too_complex: "The message structure is unsupported.",
  processing_failed:
    "The message could not be processed. This is a technical failure.",
  persistence_failed: "The result could not be stored.",
  fetch_failed: "The selected message could not be retrieved.",
  normalization_failed: "The selected message could not be normalized.",
  event_mismatch:
    "The existing Calendar event does not match the approved commitment. It was not changed.",
  invalid_approved_event: "The saved approval could not be validated safely.",
  incomplete_event: "Correct the required event details before approval.",
  invalid_input: "Check the fields and try again.",
  stale_review:
    "This review changed in another tab. Refresh it before trying again.",
  not_found: "This record is unavailable.",
  scope_not_granted: "The required Google permission was not granted.",
  approval_required:
    "Approve the reviewed commitment before creating an event.",
  record_integrity_error: "The saved record could not be interpreted safely.",
  internal_error: "The operation could not be completed.",
  request_failed: "The request could not be completed.",
};
export function safeMessage(code?: string): string {
  return code && Object.hasOwn(messages, code)
    ? messages[code]
    : "The operation could not be completed safely.";
}
export function safeFailure(
  stage: ProcessingStage,
  code?: string,
): ProcessingFailure {
  const known = [
    "microsoft_unavailable",
    "microsoft_reauthorization_required",
    "microsoft_connection_blocked",
    "microsoft_rate_limited",
    "gmail_fetch_unavailable",
    "provider_unavailable",
    "provider_timeout",
    "provider_rate_limited",
    "reauthorization_required",
    "invalid_provider_payload",
    "provider_id_mismatch",
    "invalid_body_encoding",
    "invalid_received_date",
    "message_too_large",
    "message_too_complex",
  ];
  const fallback = {
    fetch: "fetch_failed",
    normalize: "normalization_failed",
    process: "processing_failed",
    persist: "persistence_failed",
    legacy_unknown: "processing_failed",
  }[stage];
  const safeCode = code && known.includes(code) ? code : fallback;
  const retry = [
    "microsoft_unavailable",
    "gmail_fetch_unavailable",
    "provider_unavailable",
    "provider_timeout",
    "provider_rate_limited",
    "persistence_failed",
  ].includes(safeCode);
  return {
    stage,
    code: safeCode,
    message: safeMessage(safeCode),
    recovery: {
      action:
        safeCode === "reauthorization_required" ||
        safeCode === "microsoft_reauthorization_required"
          ? "reconnect"
          : retry
            ? "retry_import"
            : safeCode === "microsoft_rate_limited"
              ? "retry_import"
              : "resolve_issue",
      canRetryNow: retry,
      message:
        safeCode === "reauthorization_required" ||
        safeCode === "microsoft_reauthorization_required"
          ? "Reconnect, then retry your selected operation."
          : retry
            ? "Retry the selected import when the service is available."
            : safeCode === "microsoft_rate_limited"
              ? "Wait for the provider’s retry delay before importing again."
              : "Try again after the underlying issue has been corrected.",
    },
  };
}
export function writeRecovery(
  status: string,
  reason?: string,
  leaseActive = false,
): Recovery {
  if (status === "added")
    return {
      action: "none",
      canRetryNow: false,
      message: "The confirmed event is already saved.",
    };
  if (status === "writing" && leaseActive)
    return {
      action: "refresh",
      canRetryNow: false,
      message: "Refresh while the current Calendar operation finishes.",
    };
  if (reason === "reauthorization_required")
    return {
      action: "reconnect",
      canRetryNow: false,
      message: safeMessage(reason),
    };
  if (reason === "event_mismatch" || reason === "invalid_approved_event")
    return {
      action: "resolve_issue",
      canRetryNow: false,
      message: safeMessage(reason),
    };
  return {
    action: "retry_calendar_write",
    canRetryNow: true,
    message:
      status === "unknown"
        ? "Retry checks the same saved event before any insertion."
        : "Retry the approved Calendar write using the saved intent.",
  };
}
export function historyDisplay(
  action: string,
  reason?: string | null,
): { label: string; message?: string } {
  if (action === "connection_authorized" && reason === "outlook")
    return { label: "Outlook connected" };
  const labels: Record<string, string> = {
    automation_auto_handle: "Automatic Calendar action",
    automation_user_confirmed: "Calendar action confirmed by you",
    automation_ask_user: "Automation needs your answer",
    automation_skip: "Automation skipped an item",
    automation_blocked: "Automatic action blocked",
    automation_policy_changed: "Automation settings changed",
    automation_question_answered: "Automation question answered",
    automation_poll_problem: "Automatic import problem",
    message_processed:
      reason === "review"
        ? "Candidate created for review"
        : "Message processed",
    review_edited: "Corrections saved",
    review_approved: "Candidate approved",
    review_ignored: "Candidate ignored",
    calendar_write_started: "Calendar write attempted",
    calendar_write_added: "Added to Calendar",
    calendar_write_failed: "Calendar write failed",
    calendar_write_unknown: "Calendar outcome unknown",
    import_failed: "Import failed",
    import_fetch_failed: "Message retrieval failed",
    import_normalize_failed: "Message normalization failed",
    import_process_failed: "Candidate processing failed",
    import_persist_failed: "Result storage failed",
    content_erased: "Local source content erased",
    google_disconnected: "Google disconnected",
    microsoft_disconnected: "Outlook disconnected",
    discord_message_unsupported: "Discord announcement could not be processed",
    discord_source_changed: "Discord announcement changed",
    discord_source_deleted: "Discord announcement deleted",
    discord_source_confirmed: "Discord source decision confirmed",
    discord_connected: "Discord feed connected",
    discord_disconnected: "Discord feed disconnected",
  };
  if (
    Object.hasOwn(labels, action) &&
    action.startsWith("automation_") &&
    reason &&
    Object.hasOwn(AUTOMATION_REASON_LABELS, reason)
  )
    return {
      label: labels[action],
      message: AUTOMATION_REASON_LABELS[reason as AutomationReason],
    };
  return {
    label: Object.hasOwn(labels, action) ? labels[action] : "History recorded",
    ...(reason && !["review", "no_event"].includes(reason)
      ? { message: safeMessage(reason) }
      : {}),
  };
}

export function safeErrorCode(
  code: string,
  fallback = "internal_error",
): string {
  const fixed = new Set([
    ...Object.keys(messages),
    "account_mismatch",
    "authentication_required",
    "invalid_identity",
    "invalid_state",
    "offline_access_required",
    "csrf_rejected",
    "consent_denied",
    "invalid_selection",
    "invalid_calendar_event",
    "invalid_provider_time",
    "provider_collision",
  ]);
  return fixed.has(code) ? code : fallback;
}
