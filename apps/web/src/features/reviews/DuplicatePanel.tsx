import type {
  DuplicateCheck,
  DuplicateMatch,
  EventDraft,
} from "@hub/contracts";
import { conflictCheckNeedsDecision } from "./ConflictPanel.js";
const labels: Record<DuplicateMatch["evidence"][number], string> = {
  same_source: "Same source message",
  same_provider_event: "Same saved Calendar event",
  same_commitment_hash: "Same saved commitment fields",
  same_title: "Same title",
  similar_title: "Similar title",
  same_time: "Same start time",
  near_start_overlap: "Close start times and substantial overlap",
  same_dates: "Same date range",
  date_only_unconfirmed: "Date-only interpretation needs confirmation",
  same_duration: "Same duration",
  same_location: "Same location",
  different_location: "Locations differ — check carefully",
};
function facts(t: EventDraft["temporal"] | null): string {
  if (!t || t.kind === "unresolved") return "Temporal details unresolved";
  if (t.kind === "timed") {
    const format = (v: string) =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: t.timezone,
      }).format(new Date(v));
    return (
      format(t.start) +
      (t.end ? " – " + format(t.end) : " (end missing)") +
      " · " +
      t.timezone
    );
  }
  return t.kind === "all_day"
    ? t.startDate + " through " + t.endExclusive + " (exclusive end; all-day)"
    : t.startDate +
        (t.endDateInclusive ? " through " + t.endDateInclusive : "") +
        " (date only; unconfirmed)";
}
const reasons: Record<string, string> = {
  unresolved_time:
    "Supply valid complete temporal details for a bounded check.",
  limit_reached:
    "The page or result limit was reached; some relevant events were not checked.",
  unsupported_events: "Some records could not be interpreted safely.",
  provider_unavailable: "Calendar lookup unavailable. Try the check again.",
  reauthorization_required:
    "Reconnect Google access in Connections, then check again.",
  provider_rate_limited: "Google limited the requests. Wait and check again.",
  local_unavailable: "Local lookup unavailable. Try the check again.",
  already_added:
    "Already added. Existing receipt protection applies; no new Calendar lookup is needed.",
};
export function duplicateCheckNeedsDecision(check: DuplicateCheck): boolean {
  return (
    (check.conflicts ? conflictCheckNeedsDecision(check.conflicts) : false) ||
    check.matches.length > 0 ||
    check.truncated ||
    check.local.status !== "checked" ||
    check.google.status !== "checked"
  );
}
export function DuplicatePanel({
  check,
  draft,
  onOpenMatch,
  busy,
}: {
  busy?: boolean;
  check: DuplicateCheck;
  draft: EventDraft;
  onOpenMatch?: (id: string) => void;
}) {
  const incomplete =
    check.local.status !== "checked" ||
    check.google.status !== "checked" ||
    check.truncated;
  return (
    <section className="card" aria-label="Possible duplicate check">
      <h3>
        {check.matches.length
          ? "Possible duplicates"
          : "Possible duplicate check"}
      </h3>
      <p>
        Candidate: <strong>{draft.title || "Untitled candidate"}</strong> ·{" "}
        {facts(draft.temporal)}
      </p>
      <p className="hint">
        Checked {new Date(check.checkedAt).toLocaleString()}. Primary Calendar
        only; this bounded check does not guarantee absence of duplicates.
      </p>
      <ul>
        {(["local", "google"] as const).map((source) => (
          <li key={source}>
            {source === "local" ? "Local Hub records" : "Google Calendar"}:{" "}
            {check[source].status}.{" "}
            {check[source].reason && reasons[check[source].reason]}
          </li>
        ))}
      </ul>
      {!check.matches.length && !incomplete && (
        <p>No possible matches in checked sources.</p>
      )}
      {incomplete && (
        <p className="notice">
          Check incomplete. Unchecked data may contain a matching event.
        </p>
      )}
      {check.truncated && (
        <p className="notice">More matches were found; showing the first 20.</p>
      )}
      {check.matches.map((match) => (
        <article className="notice" key={match.key}>
          <h4>
            {match.strength === "exact_identity"
              ? "Exact identity — existing protection"
              : match.strength === "strong_possible"
                ? "Strong possible duplicate"
                : "Possible duplicate"}
          </h4>
          <p>
            <strong>{match.facts.title || "Untitled event"}</strong>
          </p>
          <p>{facts(match.facts.temporal)}</p>
          {match.facts.location && <p>Location: {match.facts.location}</p>}
          <p>
            {match.sources
              .map((s) =>
                s === "google"
                  ? "Google Calendar"
                  : "Local Hub record (as last recorded)",
              )
              .join(" + ")}
          </p>
          <ul>
            {match.evidence.map((e) => (
              <li key={e}>{labels[e]}</li>
            ))}
          </ul>
          {match.htmlLink && (
            <a href={match.htmlLink} target="_blank" rel="noreferrer">
              Open Calendar event ↗
            </a>
          )}
          {match.reviewId && onOpenMatch && (
            <button
              className="quiet"
              disabled={busy}
              onClick={() => onOpenMatch(match.reviewId!)}
            >
              Open local review
            </button>
          )}
        </article>
      ))}
      {check.matches.length > 0 && (
        <p>
          These may represent the same event. You may correct or ignore this
          candidate, or deliberately approve it anyway. This check does not
          change existing events.
        </p>
      )}
    </section>
  );
}
