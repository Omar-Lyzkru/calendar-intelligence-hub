import { useEffect, useState } from "react";
import { z } from "zod";
import {
  AutomationPolicySchema,
  AutomationSourcesSchema,
  EVENT_CATEGORY_LABELS,
  EventCategorySchema,
  type AutomationPolicyInput,
} from "@hub/contracts";
import { api } from "../../api/client.js";
type Policy = z.infer<typeof AutomationPolicySchema>;
type Source = z.infer<typeof AutomationSourcesSchema>["items"][number];
const labels = {
  gmail: "Gmail account",
  outlook: "Outlook account",
  discord: "Discord feed",
};
export function AutomationSettings() {
  const [policy, setPolicy] = useState<Policy | null>(null),
    [sources, setSources] = useState<Source[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const [p, s] = await Promise.all([
        api("/api/automation/policy", AutomationPolicySchema),
        api("/api/automation/sources", AutomationSourcesSchema),
      ]);
      if (!p || !s) throw Error();
      setPolicy(p);
      setSources(s.items);
    } catch {
      setError(
        "Automation settings are unavailable. Full Review remains available.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save() {
    if (!policy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      setPolicy(
        await api("/api/automation/policy", AutomationPolicySchema, {
          method: "PUT",
          body: {
            enabled: policy.enabled,
            pollGmail: policy.pollGmail,
            rules: policy.rules,
            expectedRevision: policy.revision,
          },
        }),
      );
      setSaved(true);
    } catch {
      setError(
        "Settings could not be saved. They may have changed elsewhere. Reload to review current settings; your choices are preserved.",
      );
    } finally {
      setBusy(false);
    }
  }
  function rule(
    index: number,
    change: Partial<AutomationPolicyInput["rules"][number]>,
  ) {
    if (!policy) return;
    setSaved(false);
    setPolicy({
      ...policy,
      rules: policy.rules.map((r, i) =>
        i === index ? { ...r, ...change } : r,
      ),
    });
  }
  return (
    <section className="card automation-settings">
      <div className="section-heading">
        <h2>Your automation rules</h2>
        <button className="quiet" disabled={busy} onClick={load}>
          Reload settings
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!policy && !error && <p role="status">Loading settings…</p>}
      {policy && (
        <>
          {!policy.liveWritesEnabled && (
            <p className="notice">
              Automatic actions are paused for live acceptance. You can save
              rules and use full Review.
            </p>
          )}
          <fieldset disabled={busy}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={policy.enabled}
                onChange={(e) => {
                  setSaved(false);
                  setPolicy({ ...policy, enabled: e.target.checked });
                }}
              />
              Enable automatic Calendar actions
            </label>
            <p className="hint">
              Only explicitly allowed sources and categories can qualify. Older
              announcements remain in manual review. Unknown facts, incomplete
              checks, possible duplicates and conflicts require attention.
            </p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={policy.pollGmail}
                onChange={(e) => {
                  setSaved(false);
                  setPolicy({ ...policy, pollGmail: e.target.checked });
                }}
              />
              Enable automatic Gmail imports
            </label>
            <p className="hint">
              While automation is enabled, read bounded windows of new Gmail
              messages. Outlook keeps selected imports; Discord uses its
              connected feed.
            </p>
            <p>
              Rules apply to the selected connected account or Discord channel.
              A mailbox rule does not verify every sender. Skip and Ask rules
              take precedence when rules overlap.
            </p>
            {policy.rules.map((r, i) => {
              const source = sources.find((s) => s.id === r.connectionId);
              return (
                <div className="automation-rule" key={i}>
                  <div className="field-grid">
                    <label>
                      Rule {i + 1} source
                      <select
                        value={r.connectionId}
                        onChange={(e) =>
                          rule(i, {
                            connectionId: e.target.value,
                            channelId: undefined,
                          })
                        }
                      >
                        {sources.map((s) => (
                          <option key={s.id} value={s.id}>
                            {labels[s.provider]}
                            {s.status !== "connected" ? " · not connected" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Rule {i + 1} category
                      <select
                        value={r.category}
                        onChange={(e) =>
                          rule(i, {
                            category: EventCategorySchema.parse(e.target.value),
                          })
                        }
                      >
                        {Object.entries(EVENT_CATEGORY_LABELS).map(
                          ([code, label]) => (
                            <option key={code} value={code}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label>
                      Rule {i + 1} action
                      <select
                        value={r.action}
                        onChange={(e) =>
                          rule(i, {
                            action: e.target.value as "auto" | "ask" | "skip",
                          })
                        }
                      >
                        <option value="ask">Ask me</option>
                        <option value="auto">
                          Auto-add after all safety checks
                        </option>
                        <option value="skip">Skip</option>
                      </select>
                    </label>
                    {source?.provider === "discord" && (
                      <label>
                        Rule {i + 1} channel
                        <select
                          value={r.channelId || ""}
                          onChange={(e) =>
                            rule(i, { channelId: e.target.value || undefined })
                          }
                        >
                          <option value="">All configured feed channels</option>
                          {source.channelIds.map((c, n) => (
                            <option key={c} value={c}>
                              Configured channel {n + 1}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  <button
                    className="quiet"
                    onClick={() =>
                      setPolicy({
                        ...policy,
                        rules: policy.rules.filter((_, n) => n !== i),
                      })
                    }
                  >
                    Remove rule {i + 1}
                  </button>
                </div>
              );
            })}
            <div className="action-row">
              <button
                className="secondary"
                disabled={!sources.length || policy.rules.length >= 100}
                onClick={() =>
                  setPolicy({
                    ...policy,
                    rules: [
                      ...policy.rules,
                      {
                        connectionId: sources[0].id,
                        category: "exam_quiz",
                        action: "ask",
                      },
                    ],
                  })
                }
              >
                Add rule
              </button>
              <button onClick={save}>Save automation settings</button>
            </div>
          </fieldset>
          {saved && <p role="status">Automation settings saved.</p>}
          {busy && <p role="status">Saving…</p>}
        </>
      )}
    </section>
  );
}
