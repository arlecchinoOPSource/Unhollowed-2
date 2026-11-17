import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  archiveCalendar,
  calendarColors,
  createCalendar,
  listCalendars,
  restoreCalendar,
  schedulingError,
  setCalendarHidden,
  setDefaultCalendar,
  updateCalendar,
  type Calendar,
  type CalendarColor,
  type CalendarInput,
} from "../../database/calendars";
import { isTauri } from "../../database/status";
import { swatchStyle } from "../labels/LabelParts";
import "./calendar.css";

function CalendarFields({
  idPrefix,
  initial,
  nameRef,
}: {
  idPrefix: string;
  initial?: CalendarInput;
  nameRef?: React.Ref<HTMLInputElement>;
}) {
  const [color, setColor] = useState<CalendarColor>(initial?.color ?? "teal");
  return (
    <>
      <label className="label-name-field">
        Calendar name
        <input
          ref={nameRef}
          name="name"
          required
          maxLength={80}
          defaultValue={initial?.name}
        />
      </label>
      <div className="label-color-field">
        <label htmlFor={`${idPrefix}-color`}>Color</label>
        <span>
          <span
            className="label-dot"
            style={swatchStyle(color)}
            aria-hidden="true"
          />
          <select
            id={`${idPrefix}-color`}
            name="color"
            value={color}
            onChange={(event) => setColor(event.target.value as CalendarColor)}
          >
            {Object.entries(calendarColors).map(([value, { name }]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </span>
      </div>
      <label className="label-description-field">
        Description (optional)
        <input
          name="description"
          maxLength={500}
          defaultValue={initial?.description ?? ""}
        />
      </label>
    </>
  );
}

function readInput(form: HTMLFormElement): CalendarInput {
  const data = new FormData(form);
  return {
    name: String(data.get("name")).trim(),
    description: String(data.get("description")).trim() || null,
    color: String(data.get("color")) as CalendarColor,
  };
}

function order(calendars: Calendar[]) {
  return [...calendars].sort(
    (a, b) =>
      Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
      Number(b.isDefault) - Number(a.isDefault) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Creates, edits, shows or hides, and archives calendars, and chooses the
 * default that new events use. Archiving keeps every event. Archiving the
 * default first asks which calendar replaces it.
 */
export function Calendars() {
  const desktop = isTauri();
  const [calendars, setCalendars] = useState<Calendar[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [request, setRequest] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const buttons = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<string | null>(null);
  const editName = useRef<HTMLInputElement>(null);
  const createName = useRef<HTMLInputElement>(null);
  const replacementSelect = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    listCalendars().then(
      (loaded) => {
        if (current) setCalendars(order(loaded));
      },
      (cause) => {
        if (current) setLoadError(schedulingError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, request]);

  useEffect(() => {
    if (pendingFocus.current === null) return;
    const key = pendingFocus.current;
    const target =
      key === "edit-form"
        ? editName.current
        : key === "create-form"
          ? createName.current
          : key === "replacement"
            ? replacementSelect.current
            : buttons.current.get(key);
    pendingFocus.current = null;
    target?.focus();
  });

  /** Applies saved calendars. Changing the default touches two rows. */
  function apply(...changed: Calendar[]) {
    setCalendars((current) => {
      const map = new Map((current ?? []).map((item) => [item.id, item]));
      for (const calendar of changed) {
        if (calendar.isDefault)
          for (const [id, item] of map)
            if (item.isDefault && id !== calendar.id)
              map.set(id, { ...item, isDefault: false });
        map.set(calendar.id, calendar);
      }
      return order([...map.values()]);
    });
  }

  async function run(work: () => Promise<void>) {
    if (saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError(schedulingError(cause));
    } finally {
      setSaving(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = readInput(event.currentTarget);
    void run(async () => {
      const calendar = await createCalendar(input);
      apply(calendar);
      pendingFocus.current = "create-form";
      setFormKey((key) => key + 1);
      setMessage(`Created calendar ${calendar.name}.`);
    });
  }

  function save(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const input = readInput(event.currentTarget);
    void run(async () => {
      const calendar = await updateCalendar(id, input);
      apply(calendar);
      setEditing(null);
      pendingFocus.current = `${id}:edit`;
      setMessage(`Saved calendar ${calendar.name}.`);
    });
  }

  function toggleHidden(calendar: Calendar) {
    void run(async () => {
      const changed = await setCalendarHidden(calendar.id, !calendar.hidden);
      apply(changed);
      setMessage(
        changed.hidden
          ? `${changed.name} is hidden from calendar views.`
          : `${changed.name} is shown in calendar views.`,
      );
    });
  }

  function makeDefault(calendar: Calendar) {
    void run(async () => {
      const changed = await setDefaultCalendar(calendar.id);
      apply(changed);
      pendingFocus.current = `${calendar.id}:edit`;
      setMessage(`${changed.name} is now the default calendar.`);
    });
  }

  function archive(calendar: Calendar, replacement?: string) {
    void run(async () => {
      const changed = await archiveCalendar(calendar.id, replacement);
      const next = replacement
        ? (await listCalendars()).find(({ id }) => id === replacement)
        : undefined;
      apply(...(next ? [next] : []), changed);
      setArchiving(null);
      pendingFocus.current = `${calendar.id}:archive`;
      setMessage(
        `Archived ${changed.name}. Its events are kept.${
          next ? ` ${next.name} is now the default calendar.` : ""
        }`,
      );
    });
  }

  function restore(calendar: Calendar) {
    void run(async () => {
      const changed = await restoreCalendar(calendar.id);
      apply(changed);
      pendingFocus.current = `${calendar.id}:archive`;
      setMessage(`Restored ${changed.name} and its events.`);
    });
  }

  const active = calendars?.filter((item) => item.archivedAt === null) ?? [];
  const archived = calendars?.filter((item) => item.archivedAt !== null) ?? [];

  function register(key: string) {
    return (element: HTMLElement | null) => {
      if (element) buttons.current.set(key, element);
    };
  }

  function row(calendar: Calendar) {
    if (editing === calendar.id)
      return (
        <li key={calendar.id} className="label-row">
          <form
            aria-label={`Edit ${calendar.name}`}
            onSubmit={(event) => save(event, calendar.id)}
          >
            <CalendarFields
              idPrefix={`edit-${calendar.id}`}
              initial={calendar}
              nameRef={editName}
            />
            <button className="action" type="submit">
              {saving ? "Saving…" : "Save calendar"}
            </button>
            <button
              type="button"
              className="label-secondary"
              onClick={() => {
                setEditing(null);
                pendingFocus.current = `${calendar.id}:edit`;
              }}
            >
              Cancel
            </button>
          </form>
        </li>
      );
    const others = active.filter(({ id }) => id !== calendar.id);
    return (
      <li key={calendar.id} className="label-row calendar-row">
        <span className="label-badge">
          <span
            className="label-dot"
            style={swatchStyle(calendar.color)}
            aria-hidden="true"
          />
          {calendar.name}
          {calendar.isDefault && (
            <span className="calendar-default"> (default)</span>
          )}
        </span>
        <p>
          {calendar.description}
          <span className="visually-hidden">
            {` Color: ${calendarColors[calendar.color].name}.`}
          </span>
        </p>
        {calendar.archivedAt === null && (
          <label className="calendar-visible">
            <input
              type="checkbox"
              checked={!calendar.hidden}
              aria-disabled={saving}
              onChange={() => toggleHidden(calendar)}
            />
            Show {calendar.name} in calendar views
          </label>
        )}
        <span className="label-row-actions">
          <button
            type="button"
            ref={register(`${calendar.id}:edit`)}
            aria-label={`Edit ${calendar.name}`}
            onClick={() => {
              pendingFocus.current = "edit-form";
              setEditing(calendar.id);
            }}
          >
            Edit
          </button>
          {calendar.archivedAt === null && !calendar.isDefault && (
            <button
              type="button"
              aria-label={`Make ${calendar.name} the default`}
              aria-disabled={saving}
              onClick={() => makeDefault(calendar)}
            >
              Make default
            </button>
          )}
          <button
            type="button"
            ref={register(`${calendar.id}:archive`)}
            aria-label={`${calendar.archivedAt ? "Restore" : "Archive"} ${calendar.name}`}
            aria-disabled={saving}
            aria-expanded={
              calendar.isDefault ? archiving === calendar.id : undefined
            }
            onClick={() => {
              if (calendar.archivedAt) restore(calendar);
              else if (calendar.isDefault) {
                pendingFocus.current = others.length ? "replacement" : null;
                setArchiving(archiving === calendar.id ? null : calendar.id);
              } else archive(calendar);
            }}
          >
            {calendar.archivedAt ? "Restore" : "Archive"}
          </button>
        </span>
        {archiving === calendar.id && (
          <form
            className="calendar-replace"
            aria-label={`Archive ${calendar.name}`}
            onSubmit={(event) => {
              event.preventDefault();
              const replacement = new FormData(event.currentTarget).get(
                "replacement",
              );
              if (replacement) archive(calendar, String(replacement));
            }}
          >
            {others.length === 0 ? (
              <p role="alert">
                {calendar.name} is the default. Create another calendar to
                become the default before archiving it.
              </p>
            ) : (
              <>
                <label>
                  New default calendar
                  <select name="replacement" ref={replacementSelect}>
                    {others.map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="action" type="submit">
                  Archive {calendar.name}
                </button>
              </>
            )}
            <button
              type="button"
              className="label-secondary"
              onClick={() => {
                setArchiving(null);
                pendingFocus.current = `${calendar.id}:archive`;
              }}
            >
              Cancel
            </button>
          </form>
        )}
      </li>
    );
  }

  return (
    <section className="labels-view calendars-view">
      <Link className="issue-back" to="/calendar">
        <ArrowLeft size={16} aria-hidden="true" /> Calendar
      </Link>
      <h1>Calendars</h1>
      <p>
        Separate your commitments by context, and hide the ones you do not need
        to see.
      </p>
      {!desktop && <p>Open the desktop app to manage your local calendars.</p>}
      {desktop && (
        <form
          key={formKey}
          aria-label="Create a calendar"
          className="label-create"
          onSubmit={create}
        >
          <CalendarFields idPrefix="new-calendar" nameRef={createName} />
          <button className="action" type="submit" aria-disabled={saving}>
            Create calendar
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>
      {loadError && (
        <div role="alert">
          <p>{loadError}</p>
          <button
            className="action"
            onClick={() => {
              setLoadError("");
              setRequest(request + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {desktop && !loadError && calendars === null && <p>Loading calendars…</p>}
      {active.length > 0 && (
        <>
          <h2>Active calendars</h2>
          <ul className="label-list">{active.map(row)}</ul>
        </>
      )}
      {archived.length > 0 && (
        <>
          <h2>Archived calendars</h2>
          <p>
            Archived calendars keep their events but hide them from calendar
            views and take no new events.
          </p>
          <ul className="label-list">{archived.map(row)}</ul>
        </>
      )}
    </section>
  );
}
