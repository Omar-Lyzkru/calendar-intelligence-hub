import { useState } from "react";
import type { z } from "zod";
import {
  DiscordConnectionSchema,
  safeMessage,
  timezone as timezoneSchema,
} from "@hub/contracts";
const gmail = "https://www.googleapis.com/auth/gmail.readonly",
  calendar = "https://www.googleapis.com/auth/calendar.events.owned";
export function Connections({
  timezone,
  status,
  scopes,
  onTimezone,
  onDisconnect,
  discord,
  discordUnavailable = false,
  onConnectDiscord,
  onDisconnectDiscord,
  onRefreshDiscord,
  outlook,
  outlookUnavailable = false,
  onConnectOutlook,
  onDisconnectOutlook,
}: {
  timezone: string;
  status: string;
  scopes: string[];
  onTimezone: (timezone: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  discord?: z.infer<typeof DiscordConnectionSchema>;
  discordUnavailable?: boolean;
  onConnectDiscord?: () => Promise<void>;
  onDisconnectDiscord?: () => Promise<void>;
  onRefreshDiscord?: () => Promise<void>;
  outlook?: { configured: boolean; status: string };
  outlookUnavailable?: boolean;
  onConnectOutlook?: () => Promise<void>;
  onDisconnectOutlook?: () => Promise<void>;
}) {
  const [zone, setZone] = useState(timezone);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await action();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <p className="eyebrow">Account & preferences</p>
      <h2>Your connections</h2>
      <p>
        Connection status: <strong>{status.replaceAll("_", " ")}</strong>
      </p>
      <div className="connection-grid">
        <div className="connection">
          <h3>Gmail</h3>
          <p>
            Read selected messages. Sending, deleting, and changing email are
            unavailable.
          </p>
          <a
            className="button secondary"
            href="/auth/google/start?intent=gmail"
          >
            {status === "connected" && scopes.includes(gmail)
              ? "Reconnect Gmail"
              : "Connect Gmail"}
          </a>
        </div>
        <div className="connection">
          <h3>Google Calendar</h3>
          <p>
            Create reviewed events on your primary calendar. No automatic
            insertion.
          </p>
          <a
            className="button secondary"
            href="/auth/google/start?intent=calendar"
          >
            {status === "connected" && scopes.includes(calendar)
              ? "Reconnect Calendar"
              : "Connect Calendar"}
          </a>
        </div>
        <div className="connection">
          <h3>Microsoft Outlook</h3>
          <p>
            Read only the messages you select. Google Calendar remains the
            destination.
          </p>
          {outlookUnavailable ? (
            <p className="notice">
              Outlook status is unavailable. Your other connections remain
              usable.
            </p>
          ) : !outlook?.configured ? (
            <p className="notice">
              Outlook is not configured in this installation.
            </p>
          ) : (
            <p>
              Outlook status:{" "}
              <strong>{outlook.status.replaceAll("_", " ")}</strong>
            </p>
          )}
          {outlook?.status === "blocked" && (
            <p className="notice">
              Check Microsoft setup or ask your school administrator about
              application consent. Broader permissions are not requested.
            </p>
          )}
          <button
            className="secondary"
            disabled={
              busy ||
              outlookUnavailable ||
              !outlook?.configured ||
              !onConnectOutlook
            }
            onClick={() => run(onConnectOutlook!)}
          >
            {outlook?.status === "connected"
              ? "Reconnect Outlook"
              : "Connect Outlook"}
          </button>
          {outlook?.status !== "disconnected" && outlook?.configured && (
            <button
              className="quiet"
              disabled={busy || !onDisconnectOutlook}
              onClick={() => run(onDisconnectOutlook!)}
            >
              Disconnect Outlook
            </button>
          )}
          <p className="hint">
            Local disconnect removes stored Microsoft credentials and does not
            revoke Microsoft consent. Remove consent through your Microsoft
            account or school administrator if needed. Imported history is
            preserved.
          </p>
        </div>
        <div className="connection">
          <h3>Discord feed</h3>
          <p>
            Automatically read published Follow announcements from your private
            feed. Every Calendar event still needs approval.
          </p>
          {discordUnavailable ? (
            <p className="notice">
              Discord status is unavailable. Your other connections remain
              usable.
            </p>
          ) : !discord?.configured ? (
            <p className="notice">
              Discord is not configured in this installation.
            </p>
          ) : (
            <>
              <p>
                Feed: <strong>{discord.runtime.state}</strong>
              </p>
              {discord.runtime.reason && (
                <p className="notice">{safeMessage(discord.runtime.reason)}</p>
              )}
              {discord.runtime.retryAfterSeconds && (
                <p>
                  Wait at least {discord.runtime.retryAfterSeconds} seconds
                  before reconnecting.
                </p>
              )}
              {discord.runtime.coverage === "capped" && (
                <p className="hint">
                  Recovery covers up to 100 recent messages per feed; older
                  announcements may be missing.
                </p>
              )}
              {discord.runtime.coverage === "incomplete" && (
                <p className="notice">
                  Feed coverage is incomplete. This is not a clean no-event
                  result.
                </p>
              )}
            </>
          )}
          <button
            className="secondary"
            disabled={
              busy ||
              discordUnavailable ||
              !discord?.configured ||
              !onConnectDiscord
            }
            onClick={() => run(onConnectDiscord!)}
          >
            {discord?.status === "connected"
              ? "Reconnect Discord"
              : "Connect Discord"}
          </button>
          {discord?.status === "connected" && (
            <button
              className="quiet"
              disabled={busy || !onDisconnectDiscord}
              onClick={() => run(onDisconnectDiscord!)}
            >
              Disconnect Discord
            </button>
          )}
          <button
            className="quiet"
            disabled={busy || !onRefreshDiscord}
            onClick={() => run(onRefreshDiscord!)}
          >
            Refresh feed status
          </button>
          <p className="hint">
            Disconnect stops ingestion and preserves imported reviews and
            history. Remove the bot in Discord if you also want to revoke its
            access.
          </p>
        </div>
      </div>
      <p className="notice">
        Gmail consent grants broad read access. This app fetches bodies only for
        messages you select.
      </p>
      <label>
        Default timezone
        <input value={zone} onChange={(e) => setZone(e.target.value)} />
      </label>
      <button
        disabled={busy || !timezoneSchema.safeParse(zone).success}
        onClick={() => run(() => onTimezone(zone))}
      >
        Save timezone
      </button>
      {status !== "disconnected" && (
        <button
          className="quiet"
          disabled={busy}
          onClick={() => run(onDisconnect)}
        >
          Disconnect Google access
        </button>
      )}
      {saved && (
        <p role="status" className="success">
          Settings saved.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p className="hint">
        Disconnect removes stored credentials. It does not erase imported
        records; delete source content in a review if needed.
      </p>
    </section>
  );
}
