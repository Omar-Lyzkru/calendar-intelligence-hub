import type { ConflictCheck } from "@hub/contracts";
const guidance: Record<string, string> = {
  unresolved_time:
    "Confirm all-day or supply complete start and end times before checking conflicts.",
  unsupported_events:
    "Some records lack reliable time or busy/free information.",
  limit_reached:
    "Some commitments could not be checked because a lookup limit was reached.",
  provider_unavailable: "Google check is unavailable. Try again.",
  reauthorization_required: "Reconnect Google access before checking again.",
  provider_rate_limited: "Google requests were limited. Wait and check again.",
  local_unavailable: "Local commitments could not be checked. Try again.",
  already_added:
    "Already added; existing write protection applies. No new conflict lookup was made.",
};
export function conflictCheckNeedsDecision(check: ConflictCheck): boolean {
  return (
    check.matches.length > 0 ||
    check.truncated ||
    check.local.status !== "checked" ||
    check.google.status !== "checked"
  );
}
export function ConflictPanel({
  check,
  checkedAt,
  busy,
  onOpenMatch,
}: {
  check: ConflictCheck;
  checkedAt: string;
  busy?: boolean;
  onOpenMatch?: (id: string) => void;
}) {
  const incomplete =
    check.local.status !== "checked" ||
    check.google.status !== "checked" ||
    check.truncated;
  const format = (v: string, zone = check.timezone) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: zone,
    }).format(new Date(v));
  return (
    <section className="card" aria-label="Calendar conflict check">
      <h3>
        {check.matches.length
          ? "Scheduling conflicts"
          : "Calendar conflict check"}
      </h3>
      <p className="hint">
        Checked {new Date(checkedAt).toLocaleString()}. Primary Calendar only;
        this bounded snapshot does not guarantee availability.
      </p>
      <ul>
        {(["local", "google"] as const).map((source) => (
          <li key={source}>
            {source === "local"
              ? "Local approved commitments"
              : "Primary Calendar commitments"}
            : {check[source].status}.{" "}
            {check[source].reason && guidance[check[source].reason]}
          </li>
        ))}
      </ul>
      {incomplete && (
        <p className="notice">
          Conflict lookup incomplete. Unchecked commitments may overlap.
        </p>
      )}
      {!incomplete && !check.matches.length && (
        <p>No overlapping commitments in checked sources.</p>
      )}
      {check.truncated && (
        <p className="notice">
          More overlaps were found; showing the first 20.
        </p>
      )}
      {check.matches.map((match) => {
        const t = match.facts.temporal,
          ms = Date.parse(match.overlap.end) - Date.parse(match.overlap.start);
        const duration =
          ms >= 60000
            ? `${(ms / 60000).toLocaleString(undefined, { maximumFractionDigits: 3 })} minutes`
            : ms >= 1000
              ? `${ms / 1000} seconds`
              : `${ms} milliseconds`;
        return (
          <article key={match.key} className="notice">
            <h4>
              {match.kind === "all_day_overlap"
                ? "All-day overlap advisory"
                : "Timed overlap"}
            </h4>
            <p>
              <strong>{match.facts.title || "Untitled commitment"}</strong>
            </p>
            {t?.kind === "timed" && (
              <p>
                {format(t.start, t.timezone)} –{" "}
                {t.end && format(t.end, t.timezone)} · {t.timezone}
              </p>
            )}
            {t?.kind === "all_day" && (
              <p>
                {t.startDate} through {t.endExclusive} (exclusive end; all-day)
              </p>
            )}
            <p>
              Overlap: {format(match.overlap.start)} –{" "}
              {format(match.overlap.end)} · {check.timezone} · {duration}
            </p>
            {match.kind === "all_day_overlap" && (
              <p>
                All-day ranges use real timezone day boundaries. This is an
                all-day advisory, not a specific appointment time.
              </p>
            )}
            <p>
              {match.sources
                .map((s) =>
                  s === "local"
                    ? "Local approved commitment (as last recorded)"
                    : "Google Calendar",
                )
                .join(" + ")}
            </p>
            {match.facts.location && <p>Location: {match.facts.location}</p>}
            {match.htmlLink && (
              <a href={match.htmlLink} target="_blank" rel="noreferrer">
                Open overlapping Calendar event ↗
              </a>
            )}
            {match.reviewId && onOpenMatch && (
              <button
                className="quiet"
                disabled={busy}
                onClick={() => onOpenMatch(match.reviewId!)}
              >
                Open overlapping local review
              </button>
            )}
          </article>
        );
      })}
      {check.matches.length > 0 && (
        <p>
          These commitments overlap the candidate. You may correct or ignore
          this candidate, or deliberately approve it anyway. Existing events are
          not changed.
        </p>
      )}
    </section>
  );
}
