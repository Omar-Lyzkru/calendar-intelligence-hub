import { Activity } from "./features/automation/Activity.js";
import { AutomationSettings } from "./features/automation/AutomationSettings.js";
import { DiscordMessages } from "./features/messages/DiscordMessages.js";
import { useEffect, useState, useRef } from "react";
import { z } from "zod";
import {
  EVENT_CATEGORY_LABELS,
  DuplicateCheckSchema,
  MeSchema,
  ConnectionSchema,
  MicrosoftConnectionSchema,
  DiscordConnectionSchema,
  DiscordMessagePageSchema,
  MessagePageSchema,
  ReviewPageSchema,
  HistoryPageSchema,
  ReviewDetailSchema,
  ImportBatchSchema,
  WriteOutcomeSchema,
  type ReviewDetail as Detail,
  type EventDraft,
  isUsableTitle,
  type Blocker,
  type MessageProvider,
  safeMessage,
} from "@hub/contracts";
import { api, setCsrf, ApiError } from "./api/client.js";
import { ReviewDetail } from "./features/reviews/ReviewDetail.js";
import { MessageSelection } from "./features/messages/MessageSelection.js";
import { Connections } from "./features/connections/Connections.js";
import { History } from "./features/history/History.js";
type View =
  | "activity"
  | "automation"
  | "reviews"
  | "messages"
  | "history"
  | "connections";
const labels: Record<View, string> = {
  activity: "Activity",
  automation: "Automation",
  reviews: "Review queue",
  messages: "Messages",
  history: "History",
  connections: "Connections",
};
export function App() {
  const [me, setMe] = useState<z.infer<typeof MeSchema> | null>(null);
  const [view, setView] = useState<View>("activity");
  const [reviews, setReviews] = useState<z.infer<typeof ReviewPageSchema>>({
    items: [],
    nextCursor: null,
  });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [messages, setMessages] = useState<z.infer<typeof MessagePageSchema>>({
    messages: [],
  });
  const [history, setHistory] = useState<z.infer<typeof HistoryPageSchema>>({
    items: [],
    nextCursor: null,
  });
  const [connections, setConnections] = useState<
    z.infer<typeof ConnectionSchema>
  >({ status: "disconnected", scopes: [] });
  const [outlook, setOutlook] = useState<
    z.infer<typeof MicrosoftConnectionSchema>
  >({ configured: false, status: "disconnected" });
  const [discord, setDiscord] = useState<
    z.infer<typeof DiscordConnectionSchema>
  >({
    configured: false,
    status: "disconnected",
    runtime: { state: "idle", coverage: "not_checked" },
  });
  const [discordUnavailable, setDiscordUnavailable] = useState(false);
  const [discordMessages, setDiscordMessages] = useState<
    z.infer<typeof DiscordMessagePageSchema>
  >({ items: [], failures: [] });
  const [outlookUnavailable, setOutlookUnavailable] = useState(false);
  const [provider, setProvider] = useState<MessageProvider>("gmail");
  const loadVersion = useRef(0);
  const [busy, setBusy] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [error, setError] = useState("");
  const [operationBlockers, setOperationBlockers] = useState<Blocker[]>([]);
  async function refreshOutlook() {
    try {
      const status = await api(
        "/api/connections/microsoft",
        MicrosoftConnectionSchema,
      );
      if (!status) throw Error("unavailable");
      setOutlook(status);
      setOutlookUnavailable(false);
    } catch {
      setOutlookUnavailable(true);
    }
  }
  async function refreshDiscord() {
    try {
      const status = await api(
        "/api/connections/discord",
        DiscordConnectionSchema,
      );
      if (!status) throw Error();
      setDiscord(status);
      setDiscordUnavailable(false);
    } catch {
      setDiscordUnavailable(true);
    }
  }
  async function initialize() {
    setBusy(true);
    try {
      const url = new URL(window.location.href);
      const outcome = url.searchParams.get("microsoft");
      const outcomes: Record<string, string> = {
        denied: safeMessage("microsoft_consent_denied"),
        blocked: safeMessage("microsoft_connection_blocked"),
        reconnect: safeMessage("microsoft_reauthorization_required"),
        failed:
          "Outlook could not be connected. Try connecting again, or check Microsoft setup with your school administrator. Your other connections are available.",
      };
      if (outcome && Object.hasOwn(outcomes, outcome)) {
        setError(outcomes[outcome]);
        setView("connections");
        url.searchParams.delete("microsoft");
        window.history.replaceState(
          null,
          "",
          url.pathname + url.search + url.hash,
        );
      }
      const current = await api("/api/me", MeSchema);
      setMe(current);
      setCsrf(current.csrf);
      if (current.user) {
        setConnections(await api("/api/connections", ConnectionSchema));
        setReviews(await api("/api/reviews", ReviewPageSchema));
        await refreshOutlook();
        await refreshDiscord();
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    initialize().catch((e) =>
      setError(e instanceof Error ? e.message : "Application unavailable"),
    );
  }, []);
  async function load(
    next: View,
    cursor?: string,
    requestedProvider?: MessageProvider,
  ) {
    const version = ++loadVersion.current;
    const source =
      requestedProvider ||
      (provider === "gmail" &&
      !connections.scopes.includes(
        "https://www.googleapis.com/auth/gmail.readonly",
      ) &&
      outlook.status === "connected"
        ? "outlook"
        : provider);
    setBusy(true);
    setError("");
    try {
      if (next === "messages") {
        setProvider(source);
        setMessages({ messages: [] });
        const canRead =
          source === "outlook"
            ? outlook.configured &&
              outlook.status === "connected" &&
              !outlookUnavailable
            : connections.status === "connected" &&
              connections.scopes.includes(
                "https://www.googleapis.com/auth/gmail.readonly",
              );
        if (source === "discord") {
          setDiscordMessages({ items: [], failures: [] });
          const page = await api(
            "/api/discord/messages" +
              (cursor ? "?pageToken=" + encodeURIComponent(cursor) : ""),
            DiscordMessagePageSchema,
          );
          if (version === loadVersion.current) setDiscordMessages(page);
        } else if (canRead) {
          const page = await api(
            "/api/" +
              source +
              "/messages" +
              (cursor ? "?pageToken=" + encodeURIComponent(cursor) : ""),
            MessagePageSchema,
          );
          if (version === loadVersion.current) setMessages(page);
        }
      }
      if (next === "history")
        setHistory(
          await api(
            "/api/history" +
              (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
            HistoryPageSchema,
          ),
        );
      if (next === "connections") {
        setConnections(await api("/api/connections", ConnectionSchema));
        await refreshOutlook();
        await refreshDiscord();
      }
      if (next === "reviews")
        setReviews(
          await api(
            "/api/reviews" +
              (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
            ReviewPageSchema,
          ),
        );
      if (version === loadVersion.current) {
        setDetail(null);
        setView(next);
      }
    } catch (e) {
      if (version === loadVersion.current) {
        setView(next);
        setError(e instanceof Error ? e.message : "Request failed");
      }
    } finally {
      if (version === loadVersion.current) setBusy(false);
    }
  }
  async function open(id: string) {
    setBusy(true);
    setError("");
    try {
      setDetail(await api("/api/reviews/" + id, ReviewDetailSchema));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review unavailable");
    } finally {
      setBusy(false);
    }
  }
  async function runReview(action: () => Promise<void>) {
    setOperationBusy(true);
    setError("");
    setOperationBlockers([]);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : "Operation failed. Your saved corrections are preserved.",
      );
      setOperationBlockers(e instanceof ApiError ? e.blockers : []);
    } finally {
      setOperationBusy(false);
    }
  }
  async function updateReview(draft: EventDraft, approve: boolean) {
    if (!detail) return;
    let current = await api("/api/reviews/" + detail.id, ReviewDetailSchema, {
      method: "PATCH",
      body: { draft, expectedRevision: detail.revision },
    });
    setDetail(current);
    if (approve) {
      current = await api(
        "/api/reviews/" + detail.id + "/approve",
        ReviewDetailSchema,
        { method: "POST", body: { expectedRevision: current.revision } },
      );
      setDetail(current);
      await api("/api/reviews/" + detail.id + "/calendar", WriteOutcomeSchema, {
        method: "POST",
      });
      setDetail(await api("/api/reviews/" + detail.id, ReviewDetailSchema));
    }
    setReviews(await api("/api/reviews", ReviewPageSchema));
  }
  async function retry() {
    if (!detail) return;
    await api("/api/reviews/" + detail.id + "/calendar", WriteOutcomeSchema, {
      method: "POST",
    });
    setDetail(await api("/api/reviews/" + detail.id, ReviewDetailSchema));
    setReviews(await api("/api/reviews", ReviewPageSchema));
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Calendar Intelligence Hub">
          <span className="brand-mark">CI</span>
          <span>
            Calendar
            <br />
            Intelligence Hub
          </span>
        </a>
        <p className="sidebar-label">YOUR WORKSPACE</p>
        <nav>
          {(Object.keys(labels) as View[]).map((v) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              disabled={!me?.user || busy || operationBusy}
              onClick={() => load(v)}
            >
              <span>{labels[v]}</span>
              <span aria-hidden="true">↗</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" />
          You control automatic actions
          <p>
            Intentional commitments.
            <br />
            Explainable decisions.
          </p>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>Personal calendar workspace</span>
          {me?.user && (
            <div>
              <span>{me.user.email}</span>
              <button
                className="quiet"
                disabled={operationBusy}
                onClick={async () => {
                  try {
                    await api("/api/logout", z.null(), { method: "POST" });
                    window.location.assign("/");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Logout failed");
                  }
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </header>
        <div className="content">
          <div className="page-heading">
            <p className="eyebrow">CALENDAR INTELLIGENCE HUB</p>
            <h1>{me?.user ? labels[view] : "Make room for what matters."}</h1>
            <p>
              See what was handled, what needs you and what could not proceed.
            </p>
          </div>
          {error && (
            <div role="alert" className="error">
              <p>{error}</p>
              {operationBlockers.length > 0 && (
                <ul>
                  {operationBlockers.map((b) => (
                    <li key={b.field + ":" + b.code}>{b.message}</li>
                  ))}
                </ul>
              )}
              <button
                className="quiet"
                onClick={() =>
                  me?.user
                    ? load(view)
                    : initialize().catch(() =>
                        setError("Application unavailable"),
                      )
                }
              >
                Try again
              </button>
            </div>
          )}
          {!me && !error && <p role="status">Loading your workspace…</p>}
          {me && !me.user && (
            <section className="card welcome">
              <p className="eyebrow">Your calendar. Your decision.</p>
              <h2>Your rules. Clear decisions.</h2>
              <p>
                Connect sources and choose rules. Automatic Calendar actions
                start off; enable them deliberately and answer focused questions
                when needed. Full Review remains available.
              </p>
              <a className="button" href="/auth/google/start?intent=login">
                Sign in with Google
              </a>
              <div className="welcome-points">
                <span>Opt-in automation</span>
                <span>Focused questions</span>
                <span>Visible processing history</span>
              </div>
            </section>
          )}
          {busy && <p role="status">Loading…</p>}
          {me?.user && !busy && (
            <>
              {view === "activity" && (
                <Activity
                  configuredZone={me.user.timezone}
                  onOpenReview={(id) => {
                    setView("reviews");
                    void open(id);
                  }}
                  onSettings={() => load("automation")}
                  onUnavailable={() =>
                    setView((v) => (v === "activity" ? "reviews" : v))
                  }
                />
              )}
              {view === "automation" && <AutomationSettings />}
              {view === "reviews" &&
                (detail ? (
                  <>
                    <button
                      className="quiet back"
                      disabled={operationBusy}
                      onClick={() => setDetail(null)}
                    >
                      ← Back to reviews
                    </button>
                    <button
                      className="quiet"
                      disabled={operationBusy}
                      onClick={() => open(detail.id)}
                    >
                      Refresh review
                    </button>
                    <ReviewDetail
                      busy={busy || operationBusy}
                      configuredZone={me.user?.timezone}
                      key={detail.id + ":" + detail.revision}
                      detail={detail}
                      onCheckDuplicates={async (draft) => {
                        setOperationBusy(true);
                        try {
                          return await api(
                            "/api/reviews/" + detail.id + "/duplicates",
                            DuplicateCheckSchema,
                            {
                              method: "POST",
                              body: {
                                expectedRevision: detail.revision,
                                ...(detail.status === "needs_review"
                                  ? { draft }
                                  : {}),
                              },
                            },
                          );
                        } finally {
                          setOperationBusy(false);
                        }
                      }}
                      onOpenMatch={(id) => {
                        open(id);
                      }}
                      onSave={(draft) =>
                        runReview(() => updateReview(draft, false))
                      }
                      onApprove={(draft) =>
                        runReview(() => updateReview(draft, true))
                      }
                      onConfirmSource={(draft) =>
                        runReview(async () => {
                          let current = detail;
                          if (detail.status === "needs_review")
                            current = await api(
                              "/api/reviews/" + detail.id,
                              ReviewDetailSchema,
                              {
                                method: "PATCH",
                                body: {
                                  draft,
                                  expectedRevision: detail.revision,
                                },
                              },
                            );
                          setDetail(current);
                          const confirmed = await api(
                            "/api/reviews/" +
                              detail.id +
                              "/source-confirmation",
                            ReviewDetailSchema,
                            {
                              method: "POST",
                              body: {
                                expectedRevision: current.revision,
                                sourceRevision: detail.source?.notice?.revision,
                              },
                            },
                          );
                          setDetail(confirmed);
                          setReviews(
                            await api("/api/reviews", ReviewPageSchema),
                          );
                        })
                      }
                      onRetry={() => runReview(retry)}
                      onIgnore={async () => {
                        await api(
                          "/api/reviews/" + detail.id + "/ignore",
                          ReviewDetailSchema,
                          {
                            method: "POST",
                            body: { expectedRevision: detail.revision },
                          },
                        );
                        await load("reviews");
                      }}
                      onDelete={async () => {
                        await api(
                          "/api/messages/" + detail.messageId + "/content",
                          z.null(),
                          { method: "DELETE" },
                        );
                        setDetail(
                          await api(
                            "/api/reviews/" + detail.id,
                            ReviewDetailSchema,
                          ),
                        );
                      }}
                    />
                  </>
                ) : (
                  <section className="card">
                    <div className="section-heading">
                      <h2>Your event candidates</h2>
                      <span className="badge">Manual approval</span>
                    </div>
                    <p className="hint">
                      Check possible duplicates and scheduling conflicts while
                      reviewing. Extraction support explains the original
                      evidence.
                    </p>
                    {!reviews.items.length ? (
                      <div className="empty">
                        <span className="empty-icon">▤</span>
                        <h3>Start with a selected message</h3>
                        <p>
                          Connect a mailbox or start a Discord feed. Imported
                          candidates appear here for review.
                        </p>
                        <button
                          onClick={() =>
                            load(
                              connections.scopes.length ||
                                outlook.status === "connected"
                                ? "messages"
                                : "connections",
                            )
                          }
                        >
                          {connections.scopes.length ||
                          outlook.status === "connected"
                            ? "Choose messages"
                            : "Set up connections"}
                        </button>
                      </div>
                    ) : (
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Event</th>
                              <th>Category</th>
                              <th>Status</th>
                              <th>Review</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reviews.items.map((r) => (
                              <tr key={r.id}>
                                <td>
                                  <strong>
                                    {isUsableTitle(
                                      r.title,
                                      r.state?.workflow.phase === "approved",
                                    )
                                      ? r.title
                                      : "Untitled candidate"}
                                  </strong>
                                </td>
                                <td>
                                  {r.eventCategory
                                    ? EVENT_CATEGORY_LABELS[r.eventCategory]
                                    : "Not categorized (legacy)"}
                                </td>
                                <td>
                                  <span className={"badge " + r.status}>
                                    {r.state?.workflow.phase ||
                                      r.status.replaceAll("_", " ")}
                                    {r.state?.workflow.phase === "review" &&
                                      (r.state.readiness.status === "ready"
                                        ? " · ready for approval"
                                        : " · needs correction")}
                                    {r.state?.workflow.phase === "approved" &&
                                      (r.status === "added"
                                        ? " · added to Calendar"
                                        : r.write?.status === "writing"
                                          ? " · Calendar write in progress"
                                          : r.write?.status === "failed"
                                            ? " · Calendar write failed"
                                            : r.write?.status === "unknown"
                                              ? " · Calendar outcome unknown"
                                              : " · awaiting Calendar write")}
                                  </span>
                                </td>
                                <td>
                                  <button
                                    className="quiet"
                                    aria-label={
                                      "Open " +
                                      (r.title || "Untitled candidate")
                                    }
                                    onClick={() => open(r.id)}
                                  >
                                    Open →
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {reviews.nextCursor && (
                      <button
                        className="secondary"
                        onClick={() => load("reviews", reviews.nextCursor!)}
                      >
                        Next review page
                      </button>
                    )}
                  </section>
                ))}
              {view === "messages" && (
                <>
                  <label>
                    Message source
                    <select
                      aria-label="Message source"
                      value={provider}
                      disabled={busy || operationBusy}
                      onChange={(e) =>
                        load(
                          "messages",
                          undefined,
                          e.target.value as MessageProvider,
                        )
                      }
                    >
                      <option value="gmail">Gmail</option>
                      <option value="outlook">Microsoft Outlook</option>
                      <option value="discord">Discord feed</option>
                    </select>
                  </label>
                  {provider !== "discord" &&
                    (provider === "outlook"
                      ? outlook.status !== "connected" ||
                        !outlook.configured ||
                        outlookUnavailable
                      : connections.status !== "connected" ||
                        !connections.scopes.includes(
                          "https://www.googleapis.com/auth/gmail.readonly",
                        )) && (
                      <p className="notice">
                        Connect {provider === "outlook" ? "Outlook" : "Gmail"}{" "}
                        in Connections to choose messages.
                      </p>
                    )}
                  {provider === "discord" ? (
                    <DiscordMessages
                      page={discordMessages}
                      onOpen={(id) => {
                        setView("reviews");
                        void open(id);
                      }}
                      onNext={() =>
                        load(
                          "messages",
                          discordMessages.nextPageToken,
                          "discord",
                        )
                      }
                    />
                  ) : (
                    <MessageSelection
                      key={
                        provider + ":" + (messages.messages[0]?.id || "empty")
                      }
                      provider={provider}
                      page={messages}
                      onNext={() => load("messages", messages.nextPageToken)}
                      onImport={async (ids) => {
                        setOperationBusy(true);
                        try {
                          const result = await api(
                            "/api/imports",
                            ImportBatchSchema,
                            {
                              method: "POST",
                              body: { provider, externalIds: ids },
                            },
                          );
                          setReviews(
                            await api("/api/reviews", ReviewPageSchema),
                          );
                          return result;
                        } finally {
                          setOperationBusy(false);
                        }
                      }}
                    />
                  )}
                </>
              )}
              {view === "history" && (
                <History
                  items={history.items}
                  next={!!history.nextCursor}
                  onNext={() => load("history", history.nextCursor!)}
                />
              )}
              {view === "connections" && (
                <Connections
                  timezone={me.user.timezone}
                  status={connections.status}
                  scopes={connections.scopes}
                  discord={discord}
                  discordUnavailable={discordUnavailable}
                  onConnectDiscord={async () => {
                    setDiscord(
                      await api(
                        "/api/connections/discord",
                        DiscordConnectionSchema,
                        { method: "POST", body: {} },
                      ),
                    );
                  }}
                  onDisconnectDiscord={async () => {
                    setDiscord(
                      await api(
                        "/api/connections/discord",
                        DiscordConnectionSchema,
                        { method: "DELETE" },
                      ),
                    );
                  }}
                  onRefreshDiscord={refreshDiscord}
                  outlook={outlook}
                  outlookUnavailable={outlookUnavailable}
                  onConnectOutlook={async () => {
                    const result = await api(
                      "/api/connections/microsoft/start",
                      z.object({ url: z.url() }),
                      { method: "POST" },
                    );
                    window.location.assign(result.url);
                  }}
                  onDisconnectOutlook={async () => {
                    setOutlook(
                      await api(
                        "/api/connections/microsoft",
                        MicrosoftConnectionSchema,
                        { method: "DELETE" },
                      ),
                    );
                  }}
                  onTimezone={async (zone) => {
                    await api("/api/me", z.object({ timezone: z.string() }), {
                      method: "PATCH",
                      body: { timezone: zone },
                    });
                    setMe({ ...me, user: { ...me.user!, timezone: zone } });
                  }}
                  onDisconnect={async () => {
                    const result = await api(
                      "/api/connections/google",
                      z.object({
                        status: z.string(),
                        remoteRevocationFailed: z.boolean(),
                      }),
                      { method: "DELETE" },
                    );
                    setConnections({ status: "disconnected", scopes: [] });
                    if (result.remoteRevocationFailed)
                      throw Error(
                        "Local credentials removed. Google revocation failed; remove access in your Google account settings.",
                      );
                  }}
                />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
