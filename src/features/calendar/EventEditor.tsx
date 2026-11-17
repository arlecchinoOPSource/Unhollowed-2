import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  calendarColors,
  schedulingError,
  type Calendar,
} from "../../database/calendars";
import {
  createEvent,
  deleteEvent,
  deviceZone,
  duplicateEvent,
  timeZones,
  updateEvent,
  type CalendarEvent,
} from "../../database/events";
import { swatchStyle } from "../labels/LabelParts";
import { draftFromEvent, toInput, type Draft } from "./eventDraft";
import "./eventEditor.css";

export type EventChange = "created" | "updated" | "duplicated" | "deleted";

/**
 * The event editor every calendar view shares. Quick fields come first, and
 * details such as the calendar, time zone, location, and link are one
 * disclosure away. A failed save keeps everything that was entered.
 */
export function EventEditor({
  event,
  draft: initialDraft,
  calendars,
  onClose,
  onChange,
}: {
  /** The event to edit, or `null` to create one from `draft`. */
  event: CalendarEvent | null;
  draft: Draft;
  calendars: Calendar[];
  onClose: () => void;
  onChange: (change: EventChange, event: CalendarEvent) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [current, setCurrent] = useState(event);
  const [draft, setDraft] = useState<Draft>(() =>
    event ? draftFromEvent(event, deviceZone()) : initialDraft,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [zones] = useState(timeZones);

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
    const result = toInput(draft);
    if (result.error !== undefined) {
      setError(result.error);
      return;
    }
    void run(async () => {
      const saved = current
        ? await updateEvent(current.id, result.input)
        : await createEvent(result.input);
      onChange(current ? "updated" : "created", saved);
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

  function remove() {
    if (!current) return;
    void run(async () => {
      await deleteEvent(current.id);
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
            Times are in {draft.timeZone}. Change it under More details.
          </p>
        )}
        <details className="event-details">
          <summary>More details</summary>
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
          {!draft.allDay && (
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
            <p>Delete {current?.title}? This cannot be undone.</p>
            <button
              ref={confirmButton}
              type="button"
              className="action event-danger"
              aria-disabled={saving}
              onClick={remove}
            >
              Delete event
            </button>
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
                  Duplicate
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
