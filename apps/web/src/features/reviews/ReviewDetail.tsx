import { OriginalExtraction } from "./OriginalExtraction.js";
import { useEffect, useRef, useState } from "react";
import {
  EVENT_CATEGORY_LABELS,
  EventCategorySchema,
  type EventCategory,
  evaluateDraft,
  deriveReviewState,
  isUsableTitle,
  safeMessage,
  EditableEventDraftSchema,
  duplicateWindow,
  type DuplicateCheck,
  type TemporalIssue,
  type Blocker,
  resolveLocalTime,
  type ReviewDetail as Detail,
  type EventDraft,
} from "@hub/contracts";
import {
  initialTime,
  TemporalInputError,
  interpretDateOnly,
  temporalFromFields,
  proposedDuration,
  type TimeFields,
} from "./timeFields.js";
import {
  DuplicatePanel,
  duplicateCheckNeedsDecision,
} from "./DuplicatePanel.js";
import { ConflictPanel } from "./ConflictPanel.js";
import { ApiError } from "../../api/client.js";
export interface ReviewProps {
  detail: Detail;
  onCheckDuplicates?: (draft: EventDraft) => Promise<DuplicateCheck>;
  onOpenMatch?: (id: string) => void;
  busy?: boolean;
  configuredZone?: string;
  onApprove: (draft: EventDraft) => Promise<void>;
  onSave: (draft: EventDraft) => Promise<void>;
  onIgnore: () => Promise<void>;
  onRetry: () => Promise<void>;
  onDelete: () => Promise<void>;
  onConfirmSource?: (draft: EventDraft) => Promise<void>;
}
export function ReviewDetail({
  detail,
  configuredZone,
  busy,
  onApprove,
  onSave,
  onIgnore,
  onRetry,
  onDelete,
  onCheckDuplicates,
  onOpenMatch,
  onConfirmSource,
}: ReviewProps) {
  const alive = useRef(true);
  const requestVersion = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requestVersion.current++;
    };
  }, []);
  const [eventCategory, setEventCategory] = useState<EventCategory | undefined>(
    detail.draft.eventCategory,
  );
  const [title, setTitle] = useState(detail.draft.title);
  const [location, setLocation] = useState(detail.draft.location || "");
  const [description, setDescription] = useState(
    detail.draft.description || "",
  );
  const [time, setTime] = useState<TimeFields>(() =>
    initialTime(detail.draft, configuredZone),
  );
  const [proposal, setProposal] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const sourceBlocked = !!detail.source?.notice?.requiresConfirmation;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [duplicateCheck, setDuplicateCheck] = useState<{
    key: string;
    at: number;
    result: DuplicateCheck;
  } | null>(null);
  const [duplicateFailure, setDuplicateFailure] = useState<{
    key: string;
    at: number;
  } | null>(null);
  const [serverBlockers, setServerBlockers] = useState<Blocker[]>([]);
  const locked =
    detail.status !== "needs_review" || detail.state?.actions.edit === false;
  let draft: EventDraft = {
    ...detail.draft,
    title,
    ...(eventCategory !== undefined ? { eventCategory } : {}),
    location: location || null,
    description: description || null,
  };
  let conversionIssues: TemporalIssue[] = [];
  try {
    draft = { ...draft, temporal: temporalFromFields(time) };
  } catch (e) {
    conversionIssues =
      e instanceof TemporalInputError
        ? e.issues
        : [
            {
              field: "temporal",
              code: "invalid_field",
              message: "Enter valid dates and times.",
            },
          ];
  }
  if (proposal && !confirmed)
    conversionIssues.push({
      field: "temporal.end",
      code: "duration_confirmation_required",
      message: "Confirm the proposed duration.",
    });
  const evaluation = evaluateDraft(draft, {
    legacyTitle: !!detail.approvedSnapshot,
    conversionIssues,
  });
  const state = deriveReviewState(detail.status, evaluation, detail.write);
  if (sourceBlocked) {
    state.actions.approve = false;
    state.actions.write = false;
  }
  const ready = evaluation.status === "ready" && !sourceBlocked;
  const timeError = conversionIssues.length > 0;
  const retryAllowed = detail.state
    ? detail.state.actions.write
    : detail.status === "approved" || detail.status === "writing";
  const startResolution = resolveLocalTime(time.start, time.timezone);
  const endResolution = resolveLocalTime(time.end, time.timezone);
  const disabled = !!busy || working;
  const changeTime = (updates: Partial<TimeFields>) => {
    setTime({
      ...time,
      ...(updates.start !== undefined ? { offset: "reject" as const } : {}),
      ...(updates.end !== undefined ? { endOffset: "reject" as const } : {}),
      ...(updates.timezone !== undefined
        ? {
            offset: "reject" as const,
            endOffset: "reject" as const,
            timezoneProvenance: "user_confirmed" as const,
          }
        : {}),
      ...updates,
    });
    setProposal(false);
    setConfirmed(false);
  };
  async function run(action: () => Promise<void>) {
    setWorking(true);
    setError("");
    setServerBlockers([]);
    try {
      await action();
    } catch (e) {
      if (!alive.current) return;
      setServerBlockers(e instanceof ApiError ? e.blockers : []);
      setError(
        e instanceof ApiError
          ? e.message
          : "Operation failed. Your edits are preserved.",
      );
    } finally {
      if (alive.current) setWorking(false);
    }
  }
  const checkKey = JSON.stringify({
    draft,
    time,
    proposal,
    confirmed,
    configuredZone,
  });
  const currentCheck = duplicateCheck?.key === checkKey ? duplicateCheck : null;
  const currentFailure =
    duplicateFailure?.key === checkKey ? duplicateFailure : null;
  const decisionNeeded =
    !!currentFailure ||
    (!!currentCheck && duplicateCheckNeedsDecision(currentCheck.result));
  const canCheck =
    !!duplicateWindow(
      draft,
      configuredZone ||
        (draft.temporal.kind === "timed" || draft.temporal.kind === "unresolved"
          ? draft.temporal.timezone
          : "UTC"),
    ) && !timeError;
  const latestContext = useRef("");
  latestContext.current = detail.id + ":" + detail.revision + ":" + checkKey;
  async function checkCurrent(): Promise<DuplicateCheck | null> {
    const context = latestContext.current;
    const request = ++requestVersion.current;
    if (!onCheckDuplicates) return null;
    setDuplicateFailure(null);
    try {
      const result = await onCheckDuplicates(draft);
      if (
        !alive.current ||
        request !== requestVersion.current ||
        context !== latestContext.current
      )
        return null;
      if (result.reviewId !== detail.id || result.revision !== detail.revision)
        throw new ApiError("stale_review", 409);
      setDuplicateCheck({ key: checkKey, at: Date.now(), result });
      return result;
    } catch (e) {
      if (
        !alive.current ||
        request !== requestVersion.current ||
        context !== latestContext.current
      )
        return null;
      setDuplicateCheck(null);
      if (e instanceof ApiError && e.status < 500) throw e;
      setDuplicateFailure({ key: checkKey, at: Date.now() });
      return null;
    }
  }
  async function approve(anyway = false) {
    const freshCheck = currentCheck && Date.now() - currentCheck.at < 60000;
    const freshFailure =
      currentFailure && Date.now() - currentFailure.at < 60000;
    if (onCheckDuplicates) {
      if (!(freshCheck || freshFailure)) {
        const checked = await checkCurrent();
        if (!checked || duplicateCheckNeedsDecision(checked)) return;
      } else if (decisionNeeded && !anyway) return;
    }
    if (alive.current) await onApprove(draft);
  }

  return (
    <section className="review-detail">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Review the commitment</p>
          <h2>
            {isUsableTitle(detail.draft.title, !!detail.approvedSnapshot)
              ? detail.draft.title
              : "Untitled candidate"}
          </h2>
        </div>
        <span className="badge">
          {detail.state?.workflow.phase || state.workflow.phase}
        </span>
      </div>
      <p className="notice">
        {onCheckDuplicates
          ? "Possible duplicate and scheduling conflict checks are advisory. Every event requires your review."
          : "Duplicate and conflict checks are unavailable in this view. Every event requires your review."}
      </p>
      {detail.source?.notice && (
        <div className="notice" role="status">
          <p>
            {detail.source.notice.kind === "changed"
              ? "This announcement changed in Discord."
              : "This announcement was deleted in Discord."}{" "}
            This review shows the original imported version. Changes do not
            imply cancellation and do not alter a saved Calendar event.
          </p>
          {detail.source.notice.requiresConfirmation && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={sourceConfirmed}
                  onChange={(e) => setSourceConfirmed(e.target.checked)}
                  disabled={disabled}
                />
                I checked the latest announcement and my reviewed event details.
              </label>
              <button
                disabled={
                  disabled ||
                  !sourceConfirmed ||
                  !onConfirmSource ||
                  timeError ||
                  !EditableEventDraftSchema.safeParse(draft).success
                }
                onClick={() => run(() => onConfirmSource!(draft))}
              >
                Confirm source decision
              </button>
              <p className="hint">
                Your current corrections are saved with this confirmation. It
                does not approve or create an event. For an already approved
                event, the saved approval stays fixed.
              </p>
            </>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="error">
          <p>{error}</p>
          {serverBlockers.length > 0 && (
            <ul>
              {serverBlockers.map((b) => (
                <li key={b.field + ":" + b.code}>{b.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {detail.write?.status === "unknown" && (
        <p role="status" className="notice">
          Outcome unknown. A retry checks for the saved event before attempting
          another insertion.
        </p>
      )}
      {detail.write?.status === "failed" && (
        <p role="status" className="error">
          Calendar write failed: {safeMessage(detail.write.reason)} Your
          approval is saved.
        </p>
      )}
      {detail.write?.status === "writing" && (
        <p role="status">
          Calendar write in progress. Refresh its status or retry after the
          active operation finishes.
        </p>
      )}
      {detail.status === "added" && (
        <p role="status" className="success">
          Added to Google Calendar{" "}
          {detail.write?.receipt && (
            <a
              href={detail.write.receipt.htmlLink}
              target="_blank"
              rel="noreferrer"
            >
              Open event ↗
            </a>
          )}
        </p>
      )}
      <div className="review-columns">
        <div>
          <fieldset disabled={locked || disabled}>
            <legend>Event details</legend>
            <label>
              Title
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={300}
              />
            </label>
            <label>
              Category
              <select
                aria-label="Category"
                value={eventCategory || ""}
                onChange={(e) =>
                  setEventCategory(
                    e.target.value
                      ? EventCategorySchema.parse(e.target.value)
                      : undefined,
                  )
                }
              >
                {detail.draft.eventCategory === undefined && (
                  <option value="">Not categorized (legacy)</option>
                )}
                {EventCategorySchema.options.map((category) => (
                  <option key={category} value={category}>
                    {EVENT_CATEGORY_LABELS[category]}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              Category is a reviewable suggestion. It does not replace required
              event details.
            </p>
            <label>
              Location
              <span className="hint"> (optional)</span>
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                maxLength={1000}
              />
            </label>
            <label>
              Description
              <span className="hint"> (optional)</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={10000}
              />
            </label>
            <label>
              Event type
              <select
                value={time.kind}
                onChange={(e) =>
                  time.kind === "date_only"
                    ? changeTime(
                        interpretDateOnly(
                          time,
                          e.target.value as "timed" | "all_day",
                        ),
                      )
                    : changeTime({
                        kind: e.target.value as TimeFields["kind"],
                        start: "",
                        end: "",
                        offset: "reject",
                        endOffset: "reject",
                      })
                }
              >
                {time.kind === "date_only" && (
                  <option value="date_only">
                    Date only — needs confirmation
                  </option>
                )}
                <option value="timed">Timed commitment</option>
                <option value="all_day">All-day event</option>
              </select>
            </label>
            {time.kind === "date_only" && (
              <div>
                <p className="hint">
                  No time was provided. Confirm all-day or enter a specific
                  time.
                </p>
                <button
                  className="secondary"
                  onClick={() => changeTime(interpretDateOnly(time, "all_day"))}
                >
                  Confirm as all-day
                </button>
                <button
                  className="secondary"
                  onClick={() => changeTime(interpretDateOnly(time, "timed"))}
                >
                  Enter a specific time
                </button>
              </div>
            )}
            {time.knownStartDate && time.kind === "timed" && (
              <p className="hint">
                Known date: {time.knownStartDate}
                {time.knownEndDate !== time.knownStartDate
                  ? ` through ${time.knownEndDate}`
                  : ""}
                . Supply the start and end times.
              </p>
            )}
            {time.partial && !time.start && (
              <p className="hint">
                Partial date: {time.partial.month ?? "unknown month"}/
                {time.partial.day ?? "unknown day"}/
                {time.partial.year ?? "year required"}. Enter a complete start
                date and time below; no year is inferred.
              </p>
            )}
            <div className="field-row">
              <label>
                Start
                <input
                  step={time.kind === "timed" ? "0.001" : undefined}
                  type={time.kind === "timed" ? "datetime-local" : "date"}
                  value={time.start}
                  onChange={(e) => changeTime({ start: e.target.value })}
                />
              </label>
              <label>
                {time.kind === "all_day"
                  ? "End date (exclusive)"
                  : time.kind === "date_only"
                    ? "Final included date (optional)"
                    : "End"}
                <input
                  step={time.kind === "timed" ? "0.001" : undefined}
                  type={time.kind === "timed" ? "datetime-local" : "date"}
                  value={time.end}
                  onChange={(e) => changeTime({ end: e.target.value })}
                />
              </label>
            </div>
            {time.kind === "timed" && (
              <>
                <label>
                  Timezone
                  <input
                    value={time.timezone}
                    onChange={(e) => changeTime({ timezone: e.target.value })}
                  />
                </label>
                <p className="hint">
                  Timezone source:{" "}
                  {time.timezoneProvenance === "explicit"
                    ? "explicit in source"
                    : time.timezoneProvenance === "assumed"
                      ? "assumed from your settings"
                      : time.timezoneProvenance === "user_confirmed"
                        ? "confirmed by you"
                        : "unknown (legacy record)"}
                  .
                </p>
                {startResolution.kind === "repeated" && (
                  <label>
                    Start occurrence
                    <select
                      value={time.offset}
                      onChange={(e) =>
                        changeTime({
                          offset: e.target.value as TimeFields["offset"],
                        })
                      }
                    >
                      <option value="reject">Choose an occurrence</option>
                      <option value="earlier">
                        First occurrence ({startResolution.earlierOffset})
                      </option>
                      <option value="later">
                        Second occurrence ({startResolution.laterOffset})
                      </option>
                    </select>
                  </label>
                )}
                {endResolution.kind === "repeated" && (
                  <label>
                    End occurrence
                    <select
                      value={time.endOffset || "reject"}
                      onChange={(e) =>
                        changeTime({
                          endOffset: e.target.value as TimeFields["offset"],
                        })
                      }
                    >
                      <option value="reject">Choose an occurrence</option>
                      <option value="earlier">
                        First occurrence ({endResolution.earlierOffset})
                      </option>
                      <option value="later">
                        Second occurrence ({endResolution.laterOffset})
                      </option>
                    </select>
                  </label>
                )}
                <button
                  className="secondary"
                  disabled={!time.start}
                  onClick={() => {
                    try {
                      setTime({ ...time, ...proposedDuration(time) });
                      setProposal(true);
                      setConfirmed(false);
                    } catch {
                      setError("Enter a valid start time first.");
                    }
                  }}
                >
                  Propose 60 minutes
                </button>
                {proposal && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    I confirm this proposed duration
                  </label>
                )}
              </>
            )}
            {time.kind === "all_day" && (
              <p className="hint">
                The exclusive end date is the day after the final included day.
              </p>
            )}
            {!locked && (
              <div aria-live="polite">
                <h3>
                  {ready ? "Ready for approval" : "What needs correction"}
                </h3>
                {!ready && (
                  <ul aria-label="Approval blockers">
                    {evaluation.blockers.map((b) => (
                      <li
                        key={b.field + ":" + b.code}
                        data-blocker-code={b.code}
                      >
                        {b.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </fieldset>
          {onCheckDuplicates && detail.status !== "ignored" && (
            <div>
              <button
                className="secondary"
                disabled={disabled || !canCheck}
                onClick={() =>
                  run(async () => {
                    await checkCurrent();
                  })
                }
              >
                Check possible duplicates
              </button>
              <p className="hint">
                This lookup also checks scheduling conflicts with approved local
                commitments and your primary Calendar.
              </p>
              {!canCheck && (
                <p className="hint">
                  Supply valid complete dates or times for a bounded duplicate
                  check.
                </p>
              )}
              {currentCheck && (
                <DuplicatePanel
                  check={currentCheck.result}
                  draft={draft}
                  busy={disabled}
                  onOpenMatch={onOpenMatch}
                />
              )}
              {currentCheck?.result.conflicts && (
                <ConflictPanel
                  check={currentCheck.result.conflicts}
                  checkedAt={currentCheck.result.checkedAt}
                  busy={disabled}
                  onOpenMatch={onOpenMatch}
                />
              )}
              {currentFailure && (
                <p role="status" className="notice">
                  Possible duplicate check unavailable. Your edits are
                  preserved. Conflict lookup is also unavailable. Try the check
                  again; this is not a clean result.
                </p>
              )}
            </div>
          )}
          {!locked && (
            <div className="actions">
              <button
                disabled={disabled || !state.actions.approve}
                onClick={() => run(() => approve())}
              >
                Approve and add
              </button>
              {onCheckDuplicates && decisionNeeded && (
                <button
                  disabled={disabled || !state.actions.approve}
                  onClick={() => run(() => approve(true))}
                >
                  Approve and add anyway
                </button>
              )}
              <button
                className="secondary"
                disabled={
                  disabled ||
                  !!timeError ||
                  !EditableEventDraftSchema.safeParse(draft).success ||
                  (proposal && !confirmed)
                }
                onClick={() => run(() => onSave(draft))}
              >
                Save corrections
              </button>
              <button
                className="quiet"
                disabled={disabled}
                onClick={() => run(onIgnore)}
              >
                Ignore
              </button>
            </div>
          )}
          {detail.state?.recovery.action === "reconnect" && (
            <p className="notice">
              Reconnect Google access in Connections before retrying.
            </p>
          )}
          {(detail.status === "approved" || detail.status === "writing") && (
            <button
              disabled={disabled || !retryAllowed}
              onClick={() => run(onRetry)}
            >
              Retry calendar write
            </button>
          )}
        </div>
        <aside className="source-panel">
          <OriginalExtraction detail={detail} current={draft} />
          <h3>Original message</h3>
          {detail.originalText !== null ? (
            <pre>{detail.originalText}</pre>
          ) : (
            <p>Original content expired or deleted.</p>
          )}
          {detail.originalText !== null && (
            <button
              className="quiet"
              disabled={disabled}
              onClick={() => run(onDelete)}
            >
              Delete local source content
            </button>
          )}
          <p className="hint">
            Only the approved event details are sent to Calendar.
          </p>
        </aside>
      </div>
    </section>
  );
}
