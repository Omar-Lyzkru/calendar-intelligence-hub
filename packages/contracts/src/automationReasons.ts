import { z } from "zod";
export const AutomationReasonSchema = z.enum([
  "eligible",
  "user_authorized",
  "automation_disabled",
  "historical",
  "source_unavailable",
  "source_changed",
  "already_added",
  "manual_state",
  "category_skipped",
  "source_untrusted",
  "category_ambiguous",
  "title_required",
  "date_required",
  "time_required",
  "all_day_confirmation",
  "timezone_confirmation",
  "facts_confirmation",
  "checks_unavailable",
  "protected_identity",
  "possible_duplicate",
  "scheduling_conflict",
  "live_acceptance_required",
  "stale",
  "action_unknown",
  "action_failed",
  "record_problem",
  "action_pending",
  "added",
  "no_event",
  "user_ignored",
  "poll_unavailable",
]);
export type AutomationReason = z.infer<typeof AutomationReasonSchema>;
export const AUTOMATION_REASON_LABELS: Record<AutomationReason, string> = {
  user_authorized:
    "You authorized this single commitment after its safety checks; your rules are unchanged.",
  eligible:
    "Your rule allows this commitment and all required checks are clear.",
  automation_disabled: "Automatic Calendar actions are disabled.",
  historical:
    "This item predates automation opt-in and remains in manual review.",
  source_unavailable:
    "The source connection is unavailable. No automatic action taken.",
  source_changed: "The source changed. Confirm its current state in Review.",
  already_added: "An existing Calendar receipt prevents another creation.",
  manual_state: "This item is already controlled by the manual workflow.",
  category_skipped: "Your rule skips this category from this source.",
  source_untrusted:
    "Add this event once? This will not enable automatic handling for this source or category.",
  category_ambiguous:
    "The category is uncertain. Choose it in Review or update your rule.",
  title_required: "What should this commitment be called?",
  date_required: "Which calendar date should this commitment use?",
  time_required: "What are the start and end times?",
  all_day_confirmation: "Should this date-only commitment be all day?",
  timezone_confirmation:
    "Which timezone and interval should this commitment use?",
  facts_confirmation: "Confirm the current event facts before continuing.",
  checks_unavailable:
    "Required duplicate or conflict checks are incomplete. No automatic action taken.",
  protected_identity:
    "An exact association requires review; no replacement event created.",
  possible_duplicate:
    "Is this a separate commitment from the possible matches?",
  scheduling_conflict: "This overlaps another commitment. Add it anyway?",
  live_acceptance_required:
    "Automatic writes are paused until the bounded live acceptance test is authorized.",
  stale: "The source, policy or candidate changed. Refresh before continuing.",
  action_unknown:
    "Calendar outcome is uncertain. Recovery will check the existing event first.",
  record_problem:
    "Saved event records need investigation. No replacement Calendar event will be created.",
  action_failed:
    "Calendar creation failed. Retry safely after resolving the problem.",
  action_pending: "Calendar creation is already in progress.",
  added: "Added to Calendar with a confirmed receipt.",
  user_ignored: "You chose to skip this commitment.",
  no_event: "No calendar commitment was detected.",
  poll_unavailable:
    "Automatic message import is paused after a provider problem. Retry after resolving it.",
};
