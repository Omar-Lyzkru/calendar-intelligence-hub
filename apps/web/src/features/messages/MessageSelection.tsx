import { ApiError } from "../../api/client.js";
import { useState } from "react";
import {
  safeFailure,
  type MessagePage,
  type ImportBatchResult,
  type MessageProvider,
} from "@hub/contracts";
export function MessageSelection({
  page,
  onImport,
  onNext,
  provider = "gmail",
}: {
  page: MessagePage;
  onImport: (ids: string[]) => Promise<ImportBatchResult>;
  onNext: () => void;
  provider?: MessageProvider;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportBatchResult | null>(null);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      setResult(await onImport(selected));
      setSelected([]);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : "Import failed. Try again when the application is available.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            {provider === "outlook" ? "Outlook" : "Gmail"} · selected messages
            only
          </p>
          <h2>Choose what to process</h2>
        </div>
        <button disabled={busy || !selected.length} onClick={submit}>
          Import selected
        </button>
      </div>
      <p className="hint">
        Import up to 20 messages. Nothing is added to your calendar at this
        step.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="success">
          {
            result.items.filter(
              (i) =>
                i.status === "review" &&
                (!i.state || i.state.workflow.phase === "review"),
            ).length
          }{" "}
          for review ·{" "}
          {result.items.filter((i) => i.status === "no_event").length} no event
          · {result.items.filter((i) => i.status === "failed").length} failed
        </p>
      )}
      {result?.items
        .filter(
          (i) =>
            i.status === "review" &&
            i.state?.workflow.phase !== "review" &&
            i.state,
        )
        .map((i) => (
          <p key={i.externalId} className="notice">
            {i.state!.workflow.phase === "ignored"
              ? "Previously ignored; your decision is preserved."
              : i.state!.recovery.action === "none" &&
                  i.state!.actions.write === false
                ? "Previously approved; check its saved Calendar outcome in the review queue."
                : "Previously approved; your approval is preserved. Open the review queue for its Calendar outcome."}
          </p>
        ))}
      {result?.items
        .filter((i) => i.status === "failed")
        .map((i) => (
          <p key={i.externalId} className="error">
            Selected message:{" "}
            {i.processingFailure?.message ||
              safeFailure("legacy_unknown", i.reason).message}
            {i.processingFailure && (
              <span> {i.processingFailure.recovery.message}</span>
            )}
            {i.processingFailure?.retryAfterSeconds && (
              <span>
                {" "}
                Wait at least {i.processingFailure.retryAfterSeconds} seconds.
              </span>
            )}
          </p>
        ))}
      {!page.messages.length && <p>No messages available.</p>}
      <div className="message-list">
        {page.messages.map((m) => (
          <label className="message-row" key={m.id}>
            <input
              type="checkbox"
              aria-label={"Select " + (m.subject || "Untitled message")}
              checked={selected.includes(m.id)}
              disabled={busy}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, m.id]
                    : selected.filter((id) => id !== m.id),
                )
              }
            />
            <span>
              <strong>{m.subject || "Untitled message"}</strong>
              <small>{m.sender}</small>
              {m.receivedAt && <small>Received: {m.receivedAt}</small>}
              <p>{m.snippet}</p>
            </span>
          </label>
        ))}
      </div>
      {page.nextPageToken && (
        <button className="secondary" disabled={busy} onClick={onNext}>
          Next message page
        </button>
      )}
    </section>
  );
}
