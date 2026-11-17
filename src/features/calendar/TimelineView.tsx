import { increments, type CalendarSettings } from "./settings";
import { CalendarPlus, ChevronLeft, ChevronRight, Repeat } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { Link, useSearchParams } from "react-router";
import { calendarColors, schedulingError } from "../../database/calendars";
import { listCalendarItems, type CalendarItem } from "../../database/events";
import { isTauri } from "../../database/status";
import { issueKey } from "../../database/issues";
import { swatchStyle } from "../labels/LabelParts";
import { addDays, parseLocalDate } from "../today/dates";
import { useLocalToday } from "../today/useLocalToday";
import { newDraft } from "./eventDraft";
import {
  DatePicker,
  displayClock,
  useCalendarPreferences,
  validDate,
} from "./preferences";
import {
  clock,
  layoutAllDay,
  layoutDay,
  minutesOf,
  MINUTES_PER_DAY,
  rangeTitle,
  stepDate,
  viewDays,
  type Block,
  type TimelineView as View,
} from "./timeline";
import { useDeviceZone } from "./useDeviceZone";
import { useEventEditing } from "./useEventEditing";
import { ViewSwitch } from "./ViewSwitch";
import "./timeline.css";

function colorName(item: CalendarItem) {
  return calendarColors[item.color as keyof typeof calendarColors]?.name;
}

/** Minutes after midnight now, updated every minute. */
function useNowMinutes(): number {
  const read = () => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  };
  const [minutes, setMinutes] = useState(read);
  useEffect(() => {
    const timer = window.setInterval(() => setMinutes(read()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return minutes;
}

function dayName(day: string, style: "short" | "long") {
  return new Intl.DateTimeFormat(undefined, {
    weekday: style,
    month: style === "long" ? "long" : undefined,
    day: "numeric",
  }).format(parseLocalDate(day));
}

/**
 * Day, Week, and Workweek: a vertical timeline of each day with an all-day
 * band, overlapping items side by side, working hours, and a line at the
 * current time. Events open the shared event editor. Work blocks and
 * deadlines link to their issues. Clicking an empty time creates an event
 * there; the New event button does the same from the keyboard.
 */
export function TimelineView({
  view,
  setIncrement,
}: {
  view: View;
  setIncrement: (value: CalendarSettings["increment"]) => void;
}) {
  const desktop = isTauri();
  const today = useLocalToday();
  const zone = useDeviceZone();
  const now = useNowMinutes();
  const settings = useCalendarPreferences();
  const [params, setParams] = useSearchParams();
  const requested = params.get("date");
  const date = validDate(requested) ? requested : today;
  const days = viewDays(view, date, settings);
  const [loaded, setLoaded] = useState<{
    key: string;
    items: CalendarItem[];
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [request, setRequest] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const editing = useEventEditing({
    onMessage: setMessage,
    onChanged: () => setRequest((value) => value + 1),
  });
  const from = days[0];
  const to = addDays(days[days.length - 1], 1);
  const key = JSON.stringify({ from, to, zone, request });

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    listCalendarItems(from, to, zone).then(
      ({ items, truncated }) => {
        if (current) setLoaded({ key, items, truncated });
      },
      (cause) => {
        if (current) setError(schedulingError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, from, to, zone, key]);

  // Start scrolled to an hour before the working day.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const hour = element.scrollHeight / 24;
    element.scrollTop = Math.max(
      0,
      (minutesOf(settings.workStart) / 60 - 1) * hour,
    );
  }, [settings.workStart, view]);

  function go(next: string) {
    const updated = new URLSearchParams(params);
    updated.set("date", next);
    setParams(updated);
  }

  if (!desktop) {
    return (
      <section>
        <h1>Calendar</h1>
        <p>Open the desktop app to see your calendar.</p>
      </section>
    );
  }

  const items = loaded?.key === key ? loaded.items : (loaded?.items ?? []);
  // Closed issues' deadlines are done; the timeline shows what is ahead.
  const visible = items.filter(
    (item) => !(item.kind === "deadline" && item.closed),
  );
  const bands = layoutAllDay(visible, days);
  const bandRows = Math.max(1, ...bands.map(({ row }) => row + 1));
  const unit = view === "day" ? "day" : "week";
  const firstShown = days.includes(today) ? today : days[0];

  function createAt(day: string, start: number) {
    const end = Math.min(MINUTES_PER_DAY - 1, start + 60);
    editing.openNew(
      newDraft(day, zone, editing.defaultCalendar, clock(start), clock(end)),
    );
  }

  function onDayClick(event: MouseEvent<HTMLDivElement>, day: string) {
    // Only empty time; items handle their own clicks.
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    const minute = ((event.clientY - box.top) / box.height) * MINUTES_PER_DAY;
    const step = settings.increment;
    createAt(
      day,
      Math.min(MINUTES_PER_DAY - step, Math.floor(minute / step) * step),
    );
  }

  function newEvent() {
    const step = settings.increment;
    const start =
      firstShown === today
        ? Math.min(MINUTES_PER_DAY - step, Math.ceil(now / step) * step)
        : minutesOf(settings.workStart);
    createAt(firstShown, start);
  }

  const gridStyle = {
    "--days": days.length,
    "--slot-lines": MINUTES_PER_DAY / settings.increment,
    "--work-top": minutesOf(settings.workStart) / MINUTES_PER_DAY,
    "--work-bottom": minutesOf(settings.workEnd) / MINUTES_PER_DAY,
  } as CSSProperties;

  return (
    <section className="calendar-view timeline-view">
      <div className="issue-page-top">
        <div>
          <h1>Calendar</h1>
          <p>Events, issue deadlines, and work blocks.</p>
          <Link className="calendar-manage" to="/calendar/calendars">
            Manage calendars
          </Link>
        </div>
        <ViewSwitch date={date} />
      </div>
      <div className="calendar-nav timeline-nav">
        <button
          type="button"
          aria-label={`Previous ${unit}`}
          onClick={() => go(stepDate(view, date, -1))}
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <h2 id="timeline-range" aria-live="polite">
          {rangeTitle(days)}
        </h2>
        <button
          type="button"
          aria-label={`Next ${unit}`}
          onClick={() => go(stepDate(view, date, 1))}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="calendar-today"
          onClick={() => go(today)}
        >
          Today
        </button>
        <button type="button" className="calendar-new-event" onClick={newEvent}>
          <CalendarPlus size={15} aria-hidden="true" /> New event
        </button>
        <DatePicker date={date} />
        <label className="timeline-grid-setting">
          Grid{" "}
          <select
            value={settings.increment}
            onChange={(event) =>
              setIncrement(
                Number(event.target.value) as CalendarSettings["increment"],
              )
            }
          >
            {increments.map((value) => (
              <option key={value} value={value}>
                {value === 60 ? "1 hour" : `${value} minutes`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(error || editing.error) && <p role="alert">{error || editing.error}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>
      {loaded?.truncated && (
        <p role="alert">
          This range has more items than can be shown. Use a shorter view.
        </p>
      )}

      <div
        className="timeline"
        role="region"
        aria-labelledby="timeline-range"
        aria-busy={loaded?.key !== key}
        style={gridStyle}
      >
        <div className="timeline-head">
          <span className="timeline-corner" aria-hidden="true" />
          {days.map((day) => (
            <div
              key={day}
              className="timeline-day-name"
              aria-current={day === today ? "date" : undefined}
              data-workday={settings.workDays.includes(
                parseLocalDate(day).getDay(),
              )}
            >
              {dayName(day, "short")}
            </div>
          ))}
        </div>

        <div
          className="timeline-allday"
          role="group"
          aria-label="All day"
          style={{ "--rows": bandRows } as CSSProperties}
        >
          <span className="timeline-allday-label" aria-hidden="true">
            All day
          </span>
          {bands.map(({ item, first, last, row }) => (
            <div
              key={item.id}
              className="timeline-band"
              data-kind={item.kind}
              style={
                {
                  gridColumn: `${first + 2} / ${last + 3}`,
                  gridRow: row + 1,
                  ...(item.color
                    ? swatchStyle(item.color as keyof typeof calendarColors)
                    : {}),
                } as CSSProperties
              }
            >
              {item.kind === "deadline" ? (
                <Link to={`/issues/${item.issueId}`}>
                  <span className="visually-hidden">Deadline: </span>
                  <span className="timeline-band-text">
                    {issueKey({ number: item.issueNumber! })} {item.title}
                  </span>
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => void editing.openItem(item)}
                >
                  <span className="timeline-band-text">{item.title}</span>
                  {item.recurring && <Repeat size={12} aria-hidden="true" />}
                  <span className="visually-hidden">
                    {`, all day, ${colorName(item) ?? ""} calendar${item.recurring ? ", repeats" : ""}. Edit event.`}
                  </span>
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Focusable so the hours can be scrolled from the keyboard, even
            when no item inside can take focus. */}
        <div
          className="timeline-scroll"
          ref={scroller}
          tabIndex={0}
          role="group"
          aria-label="Hours, scroll for earlier or later times"
        >
          <div className="timeline-grid">
            <ol className="timeline-hours" aria-hidden="true">
              {Array.from({ length: 24 }, (_, hour) => (
                <li key={hour}>
                  {displayClock(clock(hour * 60), settings.twelveHour)}
                </li>
              ))}
            </ol>
            {days.map((day) => {
              const blocks = layoutDay(visible, day);
              return (
                <div
                  key={day}
                  className="timeline-day"
                  role="group"
                  aria-label={dayName(day, "long")}
                  data-today={day === today}
                  data-workday={settings.workDays.includes(
                    parseLocalDate(day).getDay(),
                  )}
                  onClick={(event) => onDayClick(event, day)}
                >
                  {day === today && (
                    <span
                      className="timeline-now"
                      style={{ top: `${(now / MINUTES_PER_DAY) * 100}%` }}
                      aria-hidden="true"
                    />
                  )}
                  {blocks.length > 0 && (
                    <ol className="timeline-items">
                      {blocks.map((block) => (
                        <TimelineBlock
                          key={block.item.id}
                          block={block}
                          onOpen={() => void editing.openItem(block.item)}
                        />
                      ))}
                    </ol>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {editing.editor}
    </section>
  );
}

function TimelineBlock({
  block,
  onOpen,
}: {
  block: Block;
  onOpen: () => void;
}) {
  const { twelveHour } = useCalendarPreferences();
  const { item, top, bottom, column, columns } = block;
  const start = displayClock(item.start!.slice(11, 16), twelveHour);
  const end = displayClock(item.end!.slice(11, 16), twelveHour);
  const style = {
    top: `${(top / MINUTES_PER_DAY) * 100}%`,
    height: `${((bottom - top) / MINUTES_PER_DAY) * 100}%`,
    left: `${(column / columns) * 100}%`,
    width: `${(1 / columns) * 100}%`,
    ...(item.color
      ? swatchStyle(item.color as keyof typeof calendarColors)
      : {}),
  } as CSSProperties;
  const times = `${block.continuesBefore ? "…" : start}–${block.continuesAfter ? "…" : end}`;
  return (
    <li
      className="timeline-item"
      data-kind={item.kind}
      // Short items put the time and title on one line.
      data-short={bottom - top < 45}
      style={style}
    >
      {item.kind === "workBlock" ? (
        <Link to={`/issues/${item.issueId}`}>
          <span className="timeline-item-time">{times}</span>
          <span className="timeline-item-title">
            <span className="visually-hidden">Work block: </span>
            {issueKey({ number: item.issueNumber! })} {item.title}
          </span>
        </Link>
      ) : (
        <button type="button" onClick={onOpen}>
          <span className="timeline-item-time">{times}</span>
          <span className="timeline-item-title">
            {item.title}
            {item.recurring && <Repeat size={12} aria-hidden="true" />}
          </span>
          <span className="visually-hidden">
            {`, ${colorName(item) ?? ""} calendar${item.recurring ? ", repeats" : ""}. Edit event.`}
          </span>
        </button>
      )}
    </li>
  );
}
