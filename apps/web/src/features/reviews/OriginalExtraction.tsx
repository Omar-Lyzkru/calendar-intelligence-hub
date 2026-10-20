import { Temporal } from "@js-temporal/polyfill";
import {
  EVENT_CATEGORY_LABELS,
  evaluateDraft,
  type EventDraft,
  type ReviewDetail,
} from "@hub/contracts";
import { ConfidencePanel } from "./ConfidencePanel.js";
const evidenceLabels: Record<string, string> = {
  explicit_date: "Complete date",
  partial_date: "Incomplete date evidence",
  explicit_time: "Stated time",
  event_keyword: "Event wording",
  explicit_timezone: "Stated timezone",
  conflicting_zones: "Conflicting timezone evidence",
  timezone_iana: "IANA timezone",
  timezone_abbreviation: "Timezone abbreviation",
  timezone_named: "Named timezone",
  timezone_assumed: "Timezone from settings",
};
function evidenceLabel(code: string): string | null {
  if (Object.hasOwn(evidenceLabels, code)) return evidenceLabels[code];
  for (const [category, label] of Object.entries(EVENT_CATEGORY_LABELS))
    if (code === "category_keyword_" + category) return label + " wording";
  return null;
}
function temporalFacts(t: EventDraft["temporal"]): string {
  if (t.kind === "timed")
    return JSON.stringify({
      kind: t.kind,
      start: Temporal.Instant.from(t.start).toString(),
      end: t.end ? Temporal.Instant.from(t.end).toString() : null,
      timezone: t.timezone,
      timezoneProvenance: t.timezoneProvenance,
    });
  if (t.kind === "all_day")
    return JSON.stringify({
      kind: t.kind,
      start: t.startDate,
      end: t.endExclusive,
    });
  if (t.kind === "date_only")
    return JSON.stringify({
      kind: t.kind,
      start: t.startDate,
      end: t.endDateInclusive,
    });
  return JSON.stringify({
    kind: t.kind,
    timezone: t.timezone,
    partial: t.partial,
    issueCodes: t.issueCodes,
  });
}
function corrected(original: EventDraft, current: EventDraft): boolean {
  return (
    original.title !== current.title ||
    original.location !== current.location ||
    original.description !== current.description ||
    original.eventCategory !== current.eventCategory ||
    temporalFacts(original.temporal) !== temporalFacts(current.temporal)
  );
}
function temporalSummary(t: EventDraft["temporal"]): string {
  if (t.kind === "timed")
    return `Timed commitment: ${t.start} to ${t.end || "end required"}`;
  if (t.kind === "all_day")
    return `All-day dates: ${t.startDate} to ${t.endExclusive} (exclusive)`;
  if (t.kind === "date_only")
    return `Date only: ${t.startDate}${t.endDateInclusive ? " through " + t.endDateInclusive : ""}; interpretation required`;
  return "Date or time unresolved; manual interpretation required";
}
export function OriginalExtraction({
  detail,
  current,
}: {
  detail: ReviewDetail;
  current: EventDraft;
}) {
  const c = detail.candidate,
    t = c.draft.temporal,
    original = evaluateDraft(c.draft);
  return (
    <>
      <h3>Original extraction</h3>
      <p className="hint">
        These findings describe the imported message. Current corrections are
        evaluated separately.
      </p>
      {corrected(c.draft, current) && (
        <p className="hint">
          Current corrections differ from the original extraction. Original
          confidence and evidence remain unchanged.
        </p>
      )}
      <ConfidencePanel report={c.confidence} />
      <p>Extracted title: {c.draft.title || "No title extracted"}</p>
      <p>{temporalSummary(t)}</p>
      {(t.kind === "timed" || t.kind === "unresolved") && (
        <p>
          Original timezone: {t.timezone} —{" "}
          {t.timezoneProvenance === "explicit"
            ? "explicit in source"
            : t.timezoneProvenance === "assumed"
              ? "assumed from settings"
              : t.timezoneProvenance === "user_confirmed"
                ? "confirmed by reviewer"
                : "unknown provenance (legacy)"}
        </p>
      )}
      {c.classification ? (
        <>
          <p>
            Suggested category:{" "}
            {EVENT_CATEGORY_LABELS[c.classification.category]}
          </p>
          {c.classification.status === "ambiguous" && (
            <p className="notice">
              Multiple category signals:{" "}
              {c.classification.alternatives
                .map((a) => EVENT_CATEGORY_LABELS[a])
                .join(", ")}
              . Review and choose the category.
            </p>
          )}
          {c.classification.status === "other" && (
            <p className="hint">No supported category signal was found.</p>
          )}
        </>
      ) : (
        <p>No category classification recorded (legacy).</p>
      )}
      <p>Original event/deadline type: {c.draft.category}</p>
      <ul aria-label="Extraction evidence">
        {c.evidence.map((e, i) => {
          const label = evidenceLabel(e.code);
          return (
            <li key={i}>
              {label ? (
                <>
                  {e.origin
                    ? e.origin === "subject"
                      ? "Subject: "
                      : "Message body: "
                    : ""}
                  {label}
                  {e.text ? ": " + e.text : ""}
                </>
              ) : (
                "Additional extraction evidence was recorded."
              )}
            </li>
          );
        })}
      </ul>
      {original.status === "blocked" && (
        <div>
          <p className="hint">Original extraction needed correction:</p>
          <ul>
            {original.blockers.map((b) => (
              <li key={b.field + ":" + b.code}>{b.message}</li>
            ))}
          </ul>
        </div>
      )}
      {c.validationIssues.length > 0 && (
        <p className="hint">
          Original extraction recorded uncertainty. Check the source and current
          fields.
        </p>
      )}
      {detail.source && (
        <p className="hint">
          Source:{" "}
          {detail.source.provider === "gmail"
            ? "Gmail"
            : detail.source.provider === "outlook"
              ? "Outlook"
              : detail.source.provider === "discord"
                ? "Discord"
                : "Unknown source"}
          . Received: {detail.source.receivedAt}. Content:{" "}
          {detail.source.contentStatus === "available"
            ? "available"
            : "expired or deleted"}
          .
        </p>
      )}
    </>
  );
}
