import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import type { Calendar } from "../../database/calendars";
import { calendarColors, schedulingError } from "../../database/calendars";
import {
  searchCalendarItems,
  type CalendarItem,
  type CalendarSearchResults,
} from "../../database/events";
import { issueKey } from "../../database/issues";
import { swatchStyle } from "../labels/LabelParts";
import { parseLocalDate } from "../today/dates";
import { displayClock, useCalendarPreferences } from "./preferences";
import {
  defaultSearch,
  isFiltered,
  itemDate,
  itemKinds,
  searchInput,
  toggleCalendar,
  toggleKind,
  type SearchState,
} from "./searchState";
import "./search.css";

/** How long typing pauses before the search runs. */
const DEBOUNCE_MS = 200;

interface Loaded {
  key: string;
  results?: CalendarSearchResults;
  error?: string;
}

/** Searching reads only, so a failure there is never "could not save". */
function searchError(cause: unknown): string {
  const code = (cause as { code?: string } | null)?.code;
  return code === "database_unavailable" || code === "workspace_read_failed"
    ? schedulingError(cause)
    : "Could not search the calendar. Try again.";
}

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parseLocalDate(date));
}

/** What a result says about when and what it is, for sighted and screen reader users. */
export function describeItem(item: CalendarItem, twelveHour: boolean): string {
  const date = dayLabel(itemDate(item));
  const when = item.allDay
    ? date
    : `${date}, ${displayClock(item.start!.slice(11, 16), twelveHour)}`;
  const kind =
    item.kind === "event"
      ? item.recurring
        ? "Repeating event"
        : "Event"
      : `${item.kind === "deadline" ? "Deadline" : "Work block"} ${issueKey({ number: item.issueNumber ?? 0 })}${item.closed ? ", completed" : ""}`;
  return `${kind} · ${when}`;
}

/**
 * Searches and filters calendar items from any view. The query lives in the
 * parent, so it survives changing view or date. Each change cancels the last
 * search, and a reply that arrives after a newer request is ignored.
 */
export function CalendarSearch({
  state,
  onChange,
  calendars,
  today,
  zone,
  revision,
  onOpen,
}: {
  state: SearchState;
  onChange: (state: SearchState) => void;
  calendars: Calendar[];
  today: string;
  zone: string;
  /** Changes when calendar data changed, to search again. */
  revision: number;
  onOpen: (item: CalendarItem) => void;
}) {
  const { twelveHour } = useCalendarPreferences();
  const ids = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [active, setActive] = useState(0);
  const choosable = calendars.filter(
    ({ archivedAt, hidden }) => !archivedAt && !hidden,
  );
  const key = JSON.stringify([state, today, zone, revision]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const timer = window.setTimeout(
      () => {
        searchCalendarItems(searchInput(state, zone, today)).then(
          (results) => {
            if (!current) return;
            setLoaded({ key, results });
            setActive(0);
          },
          (cause) => {
            if (current) setLoaded({ key, error: searchError(cause) });
          },
        );
      },
      loaded === null ? 0 : DEBOUNCE_MS,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
    // `key` carries the state, today, zone, and revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  if (!open) {
    return (
      <div className="calendar-search-bar">
        <button
          type="button"
          className="calendar-search-toggle"
          aria-expanded={false}
          aria-controls={`${ids}-panel`}
          onClick={() => {
            setOpen(true);
            requestAnimationFrame(() => input.current?.focus());
          }}
        >
          <Search aria-hidden="true" size={16} />
          Search calendar
          {(state.text || isFiltered(state)) && (
            <span className="calendar-search-badge">Active</span>
          )}
        </button>
      </div>
    );
  }

  const fresh = loaded?.key === key ? loaded : null;
  const results = (fresh ?? loaded)?.results;
  const items = results?.items ?? [];
  const optionId = (index: number) => `${ids}-option-${index}`;

  function move(next: number) {
    if (items.length === 0) return;
    const index = (next + items.length) % items.length;
    setActive(index);
    document.getElementById(optionId(index))?.scrollIntoView?.({
      block: "nearest",
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") move(active + 1);
    else if (event.key === "ArrowUp") move(active - 1);
    else if (event.key === "Home" && items.length) move(0);
    else if (event.key === "End" && items.length) move(items.length - 1);
    else if (event.key === "Enter" && items[active]) onOpen(items[active]);
    else if (event.key === "Escape") {
      // First clear the text, then close.
      if (state.text) onChange({ ...state, text: "" });
      else setOpen(false);
    } else return;
    event.preventDefault();
  }

  const status = fresh?.error
    ? ""
    : !fresh
      ? "Searching…"
      : items.length === 0
        ? "No matching calendar items."
        : `${items.length}${results?.truncated ? "+" : ""} ${items.length === 1 ? "result" : "results"}${results?.truncated ? `. Showing the first ${items.length}; narrow the search to see others` : ""}.`;

  return (
    <div
      role="search"
      className="calendar-search"
      id={`${ids}-panel`}
      aria-label="Search calendar"
    >
      <div className="calendar-search-field">
        <Search aria-hidden="true" size={16} />
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label="Search titles and descriptions"
          aria-expanded={items.length > 0}
          aria-controls={`${ids}-results`}
          aria-activedescendant={items.length ? optionId(active) : undefined}
          aria-autocomplete="list"
          placeholder="Search titles and descriptions"
          maxLength={200}
          value={state.text}
          onChange={(event) => onChange({ ...state, text: event.target.value })}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          onClick={() => {
            onChange(defaultSearch);
            input.current?.focus();
          }}
          disabled={!state.text && !isFiltered(state)}
        >
          Clear
        </button>
        <button
          type="button"
          className="calendar-search-close"
          aria-label="Close search"
          onClick={() => setOpen(false)}
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>

      <div className="calendar-search-filters">
        <fieldset>
          <legend>Show</legend>
          {itemKinds.map(([kind, label]) => (
            <label key={kind} className="calendar-check">
              <input
                type="checkbox"
                checked={state.kinds.includes(kind)}
                onChange={() => onChange(toggleKind(state, kind))}
              />
              {label}
            </label>
          ))}
          <label className="calendar-check">
            <input
              type="checkbox"
              checked={state.includeCompleted}
              onChange={(event) =>
                onChange({ ...state, includeCompleted: event.target.checked })
              }
            />
            Completed issues
          </label>
        </fieldset>
        {choosable.length > 1 && (
          <fieldset>
            <legend>Calendars</legend>
            {choosable.map((calendar) => (
              <label key={calendar.id} className="calendar-check">
                <input
                  type="checkbox"
                  checked={
                    state.calendarIds === null ||
                    state.calendarIds.includes(calendar.id)
                  }
                  onChange={() =>
                    onChange(
                      toggleCalendar(
                        state,
                        calendar.id,
                        choosable.map(({ id }) => id),
                      ),
                    )
                  }
                />
                {calendar.name}
              </label>
            ))}
          </fieldset>
        )}
      </div>

      <p role="status" className="calendar-search-status">
        {status}
      </p>
      {fresh?.error && <p role="alert">{fresh.error}</p>}

      {items.length > 0 && (
        <ul
          id={`${ids}-results`}
          role="listbox"
          aria-label="Search results"
          className="calendar-search-results"
          aria-busy={!fresh}
        >
          {items.map((item, index) => (
            <li
              key={item.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={index === active ? "is-active" : undefined}
              data-boundary={
                results && index === results.upcoming && index > 0
                  ? "earlier"
                  : undefined
              }
              onMouseMove={() => index !== active && setActive(index)}
              onClick={() => onOpen(item)}
            >
              {item.kind === "event" && (
                <span
                  className="label-dot"
                  aria-hidden="true"
                  style={swatchStyle(
                    (item.color ?? "gray") as keyof typeof calendarColors,
                  )}
                />
              )}
              <span className="calendar-search-title">{item.title}</span>
              <span className="calendar-search-meta">
                {describeItem(item, twelveHour)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
