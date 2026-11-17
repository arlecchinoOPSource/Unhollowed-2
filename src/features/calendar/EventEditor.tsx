import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  calendarColors,
  schedulingError,
  type Calendar,
} from "../../database/calendars";
import {
  cancelOccurrence,
  createEvent,
  deleteEvent,
  deviceZone,
  duplicateEvent,
  endSeries,
  splitSeries,
  timeZones,
  updateEvent,
  updateOccurrence,
  type CalendarEvent,
  type RepeatFreq,
} from "../../database/events";
import { swatchStyle } from "../labels/LabelParts";
import {
  draftFromEvent,
  seriesInput,
  toInput,
  type Draft,
  type OccurrenceSpan,
} from "./eventDraft";
import "./eventEditor.css";

export type EventChange = "created" | "updated" | "duplicated" | "deleted";

/** Which occurrences of a recurring event a change applies to. */
type Scope = "this" | "following" | "all";

const scopes: Record<Scope, string> = {
  this: "This event",
  following: "This and following events",
  all: "All events",
};

const frequencies: Record<RepeatFreq, [string, string]> = {
  daily: ["Daily", "days"],
  weekly: ["Weekly", "weeks"],
  monthly: ["Monthly", "months"],
  yearly: ["Yearly", "years"],
};

/**
 * The event editor every calendar view shares. Quick fields come first, and
 * details such as the calendar, time zone, location, and link are one
 * disclosure away. A failed save keeps everything that was entered.
 *
 * For an occurrence of a recurring event, changes apply to this event, this
 * and following events, or all events. A single occurrence keeps its
 * identity, and changing it leaves the rest of the series alone.
 */
export function EventEditor({
  event,
  occurrence,
  draft: initialDraft,
  calendars,
  onClose,
  onChange,
}: {
  /** The event to edit, or `null` to create one from `draft`. */
  event: CalendarEvent | null;
  /** The occurrence being edited, for a recurring event. */
  occurrence?: { key: string; span: OccurrenceSpan };
  /** The starting values for a new event. */
  draft?: Draft;
  calendars: Calendar[];
  onClose: () => void;
  onChange: (change: EventChange, event: CalendarEvent, note?: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [current, setCurrent] = useState(event);
  const [draft, setDraft] = useState<Draft>(() =>
    event
      ? draftFromEvent(event, deviceZone(), occurrence?.span)
      : initialDraft!,
  );
  const [scope, setScope] = useState<Scope>("this");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [zones] = useState(timeZones);
  const recurring = Boolean(current?.repeatFreq && occurrence);
  // One occurrence cannot change the series' rule, zone, or calendar.
  const single = recurring && scope === "this";

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    title.current?.focus();
  }, []);

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  async function run(work: () => Promise<void>) {
    if (saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (cause) {
      // The form keeps every entered value, so the user can fix and retry.
      setError(schedulingError(cause));
    } finally {
      setSaving(false);
    }
  }

  function save(submit: FormEvent) {
    submit.preventDefault();
    const result = toInput(single ? { ...draft, repeatFreq: "" } : draft);
    if (result.error !== undefined) {
      setError(result.error);
      return;
    }
    const input = result.input;
    void run(async () => {
      if (!current) {
        onChange("created", await createEvent(input));
      } else if (recurring && occurrence && scope === "this") {
        await updateOccurrence(current.id, occurrence.key, {
          ...input,
          calendarId: null,
          repeat: null,
        });
        onChange("updated", { ...current, title: input.title });
      } else if (recurring && occurrence && scope === "following") {
        const split = await splitSeries(current.id, occurrence.key, input);
        const dropped = split.droppedChanges;
        onChange(
          "updated",
          split.created ?? split.series,
          dropped
            ? `${dropped} changed ${dropped === 1 ? "occurrence" : "occurrences"} could not follow the new repeat and ${dropped === 1 ? "was" : "were"} reset.`
            : undefined,
        );
      } else if (recurring && occurrence) {
        onChange(
          "updated",
          await updateEvent(
            current.id,
            seriesInput(current, occurrence.key, input),
          ),
        );
      } else {
        onChange("updated", await updateEvent(current.id, input));
      }
      onClose();
    });
  }

  function duplicate() {
    if (!current) return;
    void run(async () => {
      const copy = await duplicateEvent(current.id);
      onChange("duplicated", copy);
      setCurrent(copy);
      setDraft(draftFromEvent(copy, deviceZone()));
      setNotice("Duplicated. You are now editing the copy.");
      title.current?.focus();
    });
  }

  function remove(which: Scope) {
    if (!current) return;
    void run(async () => {
      if (recurring && occurrence && which === "this")
        await cancelOccurrence(current.id, occurrence.key);
      else if (recurring && occurrence && which === "following")
        await endSeries(current.id, occurrence.key);
      else await deleteEvent(current.id);
      onChange("deleted", current);
      onClose();
    });
  }

  const usable = calendars.filter(
    ({ archivedAt, id }) => archivedAt === null || id === draft.calendarId,
  );
  const heading = current ? "Edit event" : "New event";

  return (
    <dialog
      ref={dialog}
      className="event-editor"
      aria-labelledby="event-editor-heading"
      onClose={onClose}
      onClick={(click) => {
        if (click.target === click.currentTarget) dialog.current?.close();
      }}
    >
      <form onSubmit={save} noValidate>
        <h2 id="event-editor-heading">{heading}</h2>
        {recurring && (
          <fieldset className="event-scope">
            <legend>Apply changes to</legend>
            {(Object.keys(scopes) as Scope[]).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="scope"
                  value={value}
                  checked={scope === value}
                  onChange={() => setScope(value)}
                />
                {scopes[value]}
              </label>
            ))}
          </fieldset>
        )}
        <label className="event-field">
          Title
          <input
            ref={title}
            value={draft.title}
            maxLength={200}
            required
            onChange={(change) => set("title", change.target.value)}
          />
        </label>
        <label className="event-check">
          <input
            type="checkbox"
            checked={draft.allDay}
            // A single occurrence stays all-day or timed like its series.
            disabled={single}
            onChange={(change) => set("allDay", change.target.checked)}
          />
          All day
        </label>
        <fieldset className="event-when">
          <legend>Starts</legend>
          <label>
            Start date
            <input
              type="date"
              value={draft.startDate}
              onChange={(change) => {
                const value = change.target.value;
                setDraft((previous) => ({
                  ...previous,
                  startDate: value,
                  // Keep the end on or after a moved start.
                  endDate:
                    value && previous.endDate < value
                      ? value
                      : previous.endDate,
                }));
              }}
            />
          </label>
          {!draft.allDay && (
            <label>
              Start time
              <input
                type="time"
                value={draft.startTime}
                onChange={(change) => set("startTime", change.target.value)}
              />
            </label>
          )}
        </fieldset>
        <fieldset className="event-when">
          <legend>Ends</legend>
          <label>
            {draft.allDay ? "Last day" : "End date"}
            <input
              type="date"
              value={draft.endDate}
              onChange={(change) => set("endDate", change.target.value)}
            />
          </label>
          {!draft.allDay && (
            <label>
              End time
              <input
                type="time"
                value={draft.endTime}
                onChange={(change) => set("endTime", change.target.value)}
              />
            </label>
          )}
        </fieldset>
        {!draft.allDay && draft.timeZone !== deviceZone() && (
          <p className="event-zone-note">
            Times are in {draft.timeZone}.
            {!single && " Change it under More details."}
          </p>
        )}

        {!single && (
          <fieldset className="event-repeat">
            <legend>Repeat</legend>
            <label>
              Repeats
              <select
                value={draft.repeatFreq}
                onChange={(change) =>
                  set("repeatFreq", change.target.value as Draft["repeatFreq"])
                }
              >
                <option value="">Does not repeat</option>
                {(Object.keys(frequencies) as RepeatFreq[]).map((freq) => (
                  <option key={freq} value={freq}>
                    {frequencies[freq][0]}
                  </option>
                ))}
              </select>
            </label>
            {draft.repeatFreq && (
              <>
                <label>
                  Every
                  <span className="event-inline">
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={draft.repeatInterval}
                      onChange={(change) =>
                        set("repeatInterval", change.target.value)
                      }
                    />
                    {frequencies[draft.repeatFreq][1]}
                  </span>
                </label>
                <label>
                  Ends
                  <select
                    value={draft.repeatEnd}
                    onChange={(change) =>
                      set(
                        "repeatEnd",
                        change.target.value as Draft["repeatEnd"],
                      )
                    }
                  >
                    <option value="never">Never</option>
                    <option value="count">After a number of times</option>
                    <option value="until">On a date</option>
                  </select>
                </label>
                {draft.repeatEnd === "count" && (
                  <label>
                    Number of times
                    <input
                      type="number"
                      min={1}
                      max={999}
                      value={draft.repeatCount}
                      onChange={(change) =>
                        set("repeatCount", change.target.value)
                      }
                    />
                  </label>
                )}
                {draft.repeatEnd === "until" && (
                  <label>
                    Last date
                    <input
                      type="date"
                      value={draft.repeatUntil}
                      onChange={(change) =>
                        set("repeatUntil", change.target.value)
                      }
                    />
                  </label>
                )}
              </>
            )}
          </fieldset>
        )}

        <details className="event-details">
          <summary>More details</summary>
          {!single && (
            <label className="event-field">
              Calendar
              <span className="event-calendar">
                {calendars.length > 0 && (
                  <span
                    className="label-dot"
                    aria-hidden="true"
                    style={swatchStyle(
                      calendars.find(({ id }) => id === draft.calendarId)
                        ?.color ?? "gray",
                    )}
                  />
                )}
                <select
                  value={draft.calendarId}
                  onChange={(change) => set("calendarId", change.target.value)}
                >
                  {usable.map((calendar) => (
                    <option key={calendar.id} value={calendar.id}>
                      {calendar.name} ({calendarColors[calendar.color].name})
                      {calendar.archivedAt ? ", archived" : ""}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          )}
          {!draft.allDay && !single && (
            <label className="event-field">
              Time zone
              <select
                value={draft.timeZone}
                onChange={(change) => set("timeZone", change.target.value)}
              >
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="event-field">
            Location (optional)
            <input
              value={draft.location}
              maxLength={200}
              onChange={(change) => set("location", change.target.value)}
            />
          </label>
          <label className="event-field">
            Link (optional)
            <input
              type="url"
              inputMode="url"
              placeholder="https://"
              value={draft.url}
              maxLength={2000}
              onChange={(change) => set("url", change.target.value)}
            />
          </label>
          <label className="event-field">
            Description (optional)
            <textarea
              rows={4}
              value={draft.description}
              maxLength={10000}
              onChange={(change) => set("description", change.target.value)}
            />
          </label>
        </details>

        {error && <p role="alert">{error}</p>}
        <p role="status" className="event-notice">
          {notice}
        </p>
        {confirming ? (
          <div
            className="event-actions"
            role="group"
            aria-label="Confirm deletion"
          >
            <p>
              {recurring
                ? `Delete ${current?.title}? Choose which occurrences.`
                : `Delete ${current?.title}? This cannot be undone.`}
            </p>
            {recurring ? (
              (Object.keys(scopes) as Scope[]).map((which, index) => (
                <button
                  key={which}
                  ref={index === 0 ? confirmButton : undefined}
                  type="button"
                  className="action event-danger"
                  aria-disabled={saving}
                  onClick={() => remove(which)}
                >
                  Delete {scopes[which].toLowerCase()}
                </button>
              ))
            ) : (
              <button
                ref={confirmButton}
                type="button"
                className="action event-danger"
                aria-disabled={saving}
                onClick={() => remove("all")}
              >
                Delete event
              </button>
            )}
            <button
              type="button"
              className="event-secondary"
              onClick={() => setConfirming(false)}
            >
              Keep event
            </button>
          </div>
        ) : (
          <div className="event-actions">
            <button type="submit" className="action" aria-disabled={saving}>
              {saving ? "Saving…" : "Save event"}
            </button>
            <button
              type="button"
              className="event-secondary"
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
            {current && (
              <>
                <button
                  type="button"
                  className="event-secondary"
                  aria-disabled={saving}
                  onClick={duplicate}
                >
                  {current.repeatFreq ? "Duplicate series" : "Duplicate"}
                </button>
                <button
                  type="button"
                  className="event-secondary"
                  onClick={() => setConfirming(true)}
                >
                  Delete…
                </button>
              </>
            )}
          </div>
        )}
      </form>
    </dialog>
  );
}
