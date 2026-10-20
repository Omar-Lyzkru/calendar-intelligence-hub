import { historyDisplay } from "@hub/contracts";
export interface HistoryItem {
  id: string;
  action: string;
  reason: string | null;
  actor: string;
  createdAt: string;
  label?: string;
  message?: string;
}
export function History({
  items,
  next,
  onNext,
}: {
  items: HistoryItem[];
  next: boolean;
  onNext: () => void;
}) {
  return (
    <section className="card">
      <p className="eyebrow">Processing history</p>
      <h2>What happened</h2>
      <p className="hint">
        Safe status records, without message bodies or credentials.
      </p>
      {!items.length ? (
        <p>No history yet.</p>
      ) : (
        <ul className="history-list">
          {items.map((i) => (
            <li key={i.id}>
              <span className="history-dot" />
              <div>
                <strong>
                  {i.label || historyDisplay(i.action, i.reason).label}
                </strong>
                {(i.message || historyDisplay(i.action, i.reason).message) && (
                  <p>
                    {i.message || historyDisplay(i.action, i.reason).message}
                  </p>
                )}
                <small>
                  {new Date(i.createdAt).toLocaleString()} · {i.actor}
                </small>
              </div>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button className="secondary" onClick={onNext}>
          Next history page
        </button>
      )}
    </section>
  );
}
