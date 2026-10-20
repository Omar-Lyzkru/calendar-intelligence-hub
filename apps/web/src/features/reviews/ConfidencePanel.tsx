import {
  CONFIDENCE_SIGNAL_LABELS,
  type ConfidenceReport,
} from "@hub/contracts";
const bands = {
  low: "Low support",
  medium: "Medium support",
  high: "High support",
};
export function ConfidencePanel({
  report,
}: {
  report: ConfidenceReport | null;
}) {
  return (
    <section aria-label="Extraction confidence">
      <p>
        Confidence:{" "}
        <strong>{report ? bands[report.band] : "Not scored"}</strong>
      </p>
      {report ? (
        <>
          <p className="hint">
            Evidence support for the original extraction, not a measured
            probability. Confidence does not decide approval; current required
            fields do.
          </p>
          <ul aria-label="Confidence reasons">
            {report.signals.map((s) => (
              <li key={s.code}>{CONFIDENCE_SIGNAL_LABELS[s.code]}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="hint">
          No confidence report was recorded for this legacy extraction.
        </p>
      )}
    </section>
  );
}
