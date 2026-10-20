import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  AutomationActivitySchema,
  AutomationPolicySchema,
  AutomationDecisionSchema,
  type QuestionAnswer,
} from "@hub/contracts";
import { api } from "../../api/client.js";
import { QuestionForm } from "./QuestionForm.js";
type Page = z.infer<typeof AutomationActivitySchema>;
export function Activity({
  onOpenReview,
  onSettings,
  onUnavailable,
  configuredZone,
}: {
  onOpenReview: (id: string) => void;
  onSettings: () => void;
  onUnavailable?: () => void;
  configuredZone?: string;
}) {
  const [page, setPage] = useState<Page | null>(null),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const delayed = useRef<ReturnType<typeof setTimeout>[]>([]);
  const mounted = useRef(true);
  const generation = useRef(0);
  async function load(cursor?: string) {
    const version = ++generation.current;
    try {
      const [data, p] = await Promise.all([
        api(
          "/api/automation/activity" +
            (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
          AutomationActivitySchema,
        ),
        api("/api/automation/policy", AutomationPolicySchema),
      ]);
      if (!data || !p) throw Error();
      if (mounted.current && version === generation.current) {
        setPage(data);
        setEnabled(p.enabled);
        setError("");
      }
    } catch {
      if (mounted.current) {
        setError("Activity is unavailable. You can continue with full Review.");
        onUnavailable?.();
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => {
      if (!busy) void load();
    }, 15000);
    return () => {
      mounted.current = false;
      generation.current++;
      clearInterval(timer);
      delayed.current.forEach(clearTimeout);
    };
  }, []);
  async function action(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      if (mounted.current) {
        await load();
        delayed.current.forEach(clearTimeout);
        delayed.current = [];
        for (const delay of [1000, 3000])
          delayed.current.push(
            setTimeout(() => {
              if (mounted.current) void load();
            }, delay),
          );
      }
    } catch {
      if (mounted.current)
        setError(
          "The action could not finish. Refresh to check its current state.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const groups = [
    { decision: "ask_user", label: "Needs you" },
    { decision: "auto_handle", label: "Recent activity" },
    { decision: "blocked", label: "Problems" },
    { decision: "skip", label: "Skipped" },
  ] as const;
  return (
    <div className="activity">
      <section className="card">
        <div className="section-heading">
          <h2>Your calendar activity</h2>
          <div className="action-row">
            <button className="secondary" onClick={onSettings}>
              Automation settings
            </button>
            <button className="quiet" disabled={busy} onClick={() => load()}>
              Refresh activity
            </button>
            <button
              disabled={busy}
              onClick={() =>
                action(() =>
                  api(
                    "/api/automation/run",
                    z.object({ status: z.literal("scheduled") }),
                    { method: "POST", body: {} },
                  ),
                )
              }
            >
              Check now
            </button>
          </div>
        </div>
        {!enabled && (
          <p className="notice">
            Automatic Calendar actions are off. Enable them only for the sources
            and categories you choose.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!page && !error && <p role="status">Loading activity…</p>}
        {page && !page.items.length && (
          <p>
            No activity yet. Connect sources and choose rules, or use Messages
            and full Review.
          </p>
        )}
      </section>
      {page?.polls
        .filter((p) => p.status !== "ready")
        .map((p) => (
          <section className="card" key={p.connectionId}>
            <h2>Import problem</h2>
            <p>
              No new automatic import was completed for this source. Resolve its
              connection or provider problem, then retry.
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                action(() =>
                  api(
                    "/api/automation/polls/" + p.connectionId + "/retry",
                    z.object({ status: z.literal("retry") }),
                    { method: "POST", body: {} },
                  ),
                )
              }
            >
              Retry imports
            </button>
          </section>
        ))}
      {groups.map((group) => {
        const items =
          page?.items.filter((i) => i.decision === group.decision) || [];
        return items.length ? (
          <section className="activity-group" key={group.decision}>
            <h2>{group.label}</h2>
            {items.map((item) => (
              <article
                className={"card activity-item " + item.decision}
                key={item.id}
              >
                <div className="section-heading">
                  <h3>{item.title}</h3>
                  <span className="badge">
                    {item.reason === "added"
                      ? "Added to Calendar"
                      : group.label}
                  </span>
                </div>
                {!item.question && <p>{item.explanation}</p>}
                <time className="hint" dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString()}
                </time>
                {item.question && (
                  <QuestionForm
                    key={item.question.id}
                    question={item.question}
                    title={item.title}
                    configuredZone={configuredZone}
                    onSettings={onSettings}
                    onAnswer={async (answer: QuestionAnswer) => {
                      await api(
                        "/api/automation/questions/" +
                          item.question!.id +
                          "/answer",
                        AutomationDecisionSchema,
                        {
                          method: "POST",
                          body: {
                            expectedRevision: item.question!.reviewRevision,
                            answer,
                          },
                        },
                      );
                      if (mounted.current) await load();
                    }}
                  />
                )}
                <div className="action-row">
                  {item.reviewId && (
                    <button
                      className="quiet"
                      onClick={() => onOpenReview(item.reviewId!)}
                    >
                      Open full review
                    </button>
                  )}
                  {item.decision === "blocked" && item.reviewId && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        action(() =>
                          api(
                            "/api/automation/reviews/" +
                              item.reviewId +
                              "/evaluate",
                            AutomationDecisionSchema,
                            { method: "POST", body: {} },
                          ),
                        )
                      }
                    >
                      Check again safely
                    </button>
                  )}
                </div>
              </article>
            ))}
          </section>
        ) : null;
      })}
      {page?.nextCursor && (
        <button className="secondary" onClick={() => load(page.nextCursor!)}>
          Next activity page
        </button>
      )}
    </div>
  );
}
