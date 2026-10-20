import { useState } from "react";
import { z } from "zod";
import {
  EVENT_CATEGORY_LABELS,
  EventCategorySchema,
  AutomationQuestionSchema,
  type QuestionAnswer,
  type EventDraft,
  resolveLocalTime,
} from "@hub/contracts";
import {
  initialTime,
  temporalFromFields,
  TemporalInputError,
  type TimeFields,
} from "../reviews/timeFields.js";
export type Question = z.infer<typeof AutomationQuestionSchema>;
export function TemporalSummary({
  temporal,
}: {
  temporal: EventDraft["temporal"] | null | undefined;
}) {
  if (!temporal) return null;
  if (temporal.kind === "timed")
    return (
      <p className="hint">
        {new Date(temporal.start).toLocaleString(undefined, {
          timeZone: temporal.timezone,
        })}{" "}
        –{" "}
        {temporal.end
          ? new Date(temporal.end).toLocaleString(undefined, {
              timeZone: temporal.timezone,
            })
          : "End needed"}{" "}
        · {temporal.timezone}
      </p>
    );
  if (temporal.kind === "all_day")
    return (
      <p className="hint">
        All day · {temporal.startDate} · ends before {temporal.endExclusive}
      </p>
    );
  if (temporal.kind === "date_only")
    return (
      <p className="hint">
        Date only · {temporal.startDate}
        {temporal.endDateInclusive
          ? " through " + temporal.endDateInclusive
          : ""}
      </p>
    );
  return <p className="hint">Date or time needs confirmation.</p>;
}
export function QuestionForm({
  question,
  title,
  onAnswer,
  onSettings,
  configuredZone = "America/Chicago",
}: {
  question: Question;
  title: string;
  onAnswer: (answer: QuestionAnswer) => Promise<void>;
  onSettings: () => void;
  configuredZone?: string;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("exam_quiz");
  const [enterTimes, setEnterTimes] = useState(false);
  const [fields, setFields] = useState<TimeFields>(() => {
    const draft = {
      title,
      location: null,
      description: null,
      category: "unknown" as const,
      temporal: question.suggestedTemporal || {
        kind: "unresolved" as const,
        text: "",
        timezone: configuredZone,
      },
    };
    const f = initialTime(draft, configuredZone);
    return {
      ...f,
      kind: "timed",
      start:
        f.kind === "timed"
          ? f.start ||
            (f.knownStartDate && f.partial?.startClock
              ? f.knownStartDate + "T" + f.partial.startClock
              : "")
          : "",
      end:
        f.kind === "timed"
          ? f.end ||
            (f.knownEndDate && f.partial?.endClock
              ? f.knownEndDate + "T" + f.partial.endClock
              : "")
          : "",
    };
  });
  async function submit(answer: QuestionAnswer) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onAnswer(answer);
    } catch {
      setError(
        "The answer could not be saved. Refresh to check for changes; your entered facts are preserved.",
      );
    } finally {
      setBusy(false);
    }
  }
  function saveTimes() {
    setError("");
    try {
      const temporal = temporalFromFields({
        ...fields,
        kind: "timed",
        timezoneProvenance: "user_confirmed",
      });
      if (temporal.kind !== "timed" || !temporal.end) {
        setError("Enter both start and end times.");
        return;
      }
      void submit({ kind: "temporal", value: temporal });
    } catch (error) {
      setError(
        error instanceof TemporalInputError
          ? error.issues[0]?.message || "Correct the date and time."
          : "Correct the date and time.",
      );
    }
  }
  const timeQuestion =
    ["time", "timezone"].includes(question.kind) ||
    (question.kind === "all_day" && enterTimes);
  return (
    <div className="focused-question">
      <p className="question-prompt">{question.prompt}</p>
      {[
        "all_day",
        "time",
        "timezone",
        "facts",
        "duplicate",
        "conflict",
      ].includes(question.kind) && (
        <TemporalSummary temporal={question.suggestedTemporal} />
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <fieldset disabled={busy}>
        {question.kind === "title" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit({ kind: "title", value });
            }}
          >
            <label>
              Event title
              <input
                value={value}
                maxLength={300}
                required
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <button>Save answer</button>
          </form>
        )}
        {question.kind === "date" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit({ kind: "date", value });
            }}
          >
            <label>
              Calendar date
              <input
                type="date"
                value={value}
                required
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <button>Save answer</button>
          </form>
        )}
        {question.kind === "category" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit({
                kind: "category",
                value: EventCategorySchema.parse(category),
              });
            }}
          >
            <label>
              Event category
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {Object.entries(EVENT_CATEGORY_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button>Save answer</button>
          </form>
        )}
        {question.kind === "all_day" && !enterTimes && (
          <div className="action-row">
            <button onClick={() => submit({ kind: "all_day", value: true })}>
              Use all day
            </button>
            <button className="secondary" onClick={() => setEnterTimes(true)}>
              Enter times
            </button>
          </div>
        )}
        {timeQuestion && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveTimes();
            }}
          >
            <div className="field-grid">
              <label>
                Start date and time
                <input
                  type="datetime-local"
                  step="0.001"
                  value={fields.start}
                  onChange={(e) =>
                    setFields({
                      ...fields,
                      start: e.target.value,
                      offset: "reject",
                    })
                  }
                  required
                />
              </label>
              <label>
                End date and time
                <input
                  type="datetime-local"
                  step="0.001"
                  value={fields.end}
                  onChange={(e) =>
                    setFields({
                      ...fields,
                      end: e.target.value,
                      endOffset: "reject",
                    })
                  }
                  required
                />
              </label>
              <label>
                Timezone
                <input
                  value={fields.timezone}
                  onChange={(e) =>
                    setFields({
                      ...fields,
                      timezone: e.target.value,
                      offset: "reject",
                      endOffset: "reject",
                    })
                  }
                  required
                />
              </label>
            </div>
            {(["start", "end"] as const).map(
              (side) =>
                resolveLocalTime(fields[side], fields.timezone).kind ===
                  "repeated" && (
                  <label key={side}>
                    {side === "start" ? "Start occurrence" : "End occurrence"}
                    <select
                      value={
                        side === "start"
                          ? fields.offset
                          : fields.endOffset || "reject"
                      }
                      onChange={(e) =>
                        setFields({
                          ...fields,
                          [side === "start" ? "offset" : "endOffset"]:
                            e.target.value,
                        })
                      }
                    >
                      <option value="reject">Choose occurrence</option>
                      <option value="earlier">Earlier occurrence</option>
                      <option value="later">Later occurrence</option>
                    </select>
                  </label>
                ),
            )}
            <button>Save answer</button>
          </form>
        )}
        {question.kind === "facts" && (
          <>
            <strong>{title}</strong>
            <button onClick={() => submit({ kind: "confirm", value: true })}>
              {question.oneTimeApproval
                ? "Add this event once"
                : "Confirm these facts"}
            </button>
          </>
        )}
        {(question.kind === "duplicate" || question.kind === "conflict") && (
          <>
            <ul className="advisory-context">
              {question.matches?.map((match, i) => (
                <li key={i}>
                  <strong>{match.title}</strong>
                  <TemporalSummary temporal={match.temporal} />
                </li>
              ))}
            </ul>
            <button onClick={() => submit({ kind: "confirm", value: true })}>
              {question.kind === "duplicate"
                ? "Add as a separate commitment"
                : "Add despite conflict"}
            </button>
          </>
        )}
        {question.kind === "source" && (
          <p>
            Open full Review to confirm the source change. Existing Calendar
            events will not be changed automatically.
          </p>
        )}
        <button className="quiet" onClick={() => submit({ kind: "skip" })}>
          Skip this item
        </button>
      </fieldset>
      {busy && <p role="status">Saving answer and checking safety…</p>}
    </div>
  );
}
