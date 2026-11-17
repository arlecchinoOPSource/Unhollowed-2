import { increments, type CalendarSettings } from "./settings";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Flag,
  Repeat,
  Timer,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Link, useSearchParams } from "react-router";
import { calendarColors, schedulingError } from "../../database/calendars";
import { listCalendarItems, type CalendarItem } from "../../database/events";
import { isTauri } from "../../database/status";
import { issueKey } from "../../database/issues";
import { swatchStyle } from "../labels/LabelParts";
import { addDays, isOverdue, parseLocalDate } from "../today/dates";
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
import { availability, conflictsOf, workWindow } from "./intervals";
import { ViewSwitch } from "./ViewSwitch";
import { proposedSpan, type GestureMode } from "./schedulingGesture";
import "./timeline.css";

interface Slot {
  day: string;
  minute: number;
}
interface Gesture {
  pointer: number;
  x: number;
  y: number;
  origin: Slot;
  item?: CalendarItem;
  mode: GestureMode;
  dragged: boolean;
}

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
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);
  const [preview, setPreview] = useState<{
    from: Slot;
    to: Slot;
    selecting: boolean;
  } | null>(null);
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
  // Closed issues' deadlines are done; show them only when asked, as Month does.
  const showClosed = params.get("closed") === "1";
  const visible = items.filter(
    (item) => !(item.kind === "deadline" && item.closed && !showClosed),
  );
  const conflicts = conflictsOf(visible);
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

  function slot(element: HTMLElement, y: number): Slot {
    const box = element.getBoundingClientRect();
    const step = settings.increment;
    const minute = element.dataset.scheduleTimeline
      ? Math.min(
          MINUTES_PER_DAY - step,
          Math.max(
            0,
            Math.floor(
              (((y - box.top) / box.height) * MINUTES_PER_DAY) / step,
            ) * step,
          ),
        )
      : 0;
    return { day: element.dataset.scheduleDay!, minute };
  }

  function begin(event: PointerEvent<HTMLDivElement>) {
    swallowClick.current = false;
    if (
      event.button !== 0 ||
      event.pointerType !== "mouse" ||
      !(event.target instanceof HTMLElement)
    )
      return;
    const handle = event.target.closest<HTMLElement>("[data-schedule-item]");
    const column = event.target.closest<HTMLElement>("[data-schedule-day]");
    const item = handle
      ? visible.find(({ id }) => id === handle.dataset.scheduleItem)
      : undefined;
    if (
      (!item &&
        (!column ||
          event.target !== column ||
          !column.dataset.scheduleTimeline)) ||
      item?.kind === "workBlock"
    )
      return;
    const origin = column
      ? slot(column, event.clientY)
      : { day: item!.startDate!, minute: 0 };
    gesture.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin,
      item,
      mode: event.target.closest("[data-resize]") ? "resize" : "move",
      dragged: false,
    };
  }

  function targetSlot(
    event: PointerEvent<HTMLDivElement>,
    item?: CalendarItem,
  ) {
    const candidate = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-schedule-day]");
    if (
      !candidate ||
      !event.currentTarget.contains(candidate) ||
      (!item?.allDay && !candidate.dataset.scheduleTimeline)
    )
      return;
    return slot(candidate, event.clientY);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    if (
      !active.dragged &&
      Math.hypot(event.clientX - active.x, event.clientY - active.y) < 5
    )
      return;
    if (!active.dragged) event.currentTarget.setPointerCapture(event.pointerId);
    active.dragged = true;
    const to = targetSlot(event, active.item);
    setPreview(
      to ? { from: active.origin, to, selecting: !active.item } : null,
    );
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    gesture.current = null;
    setPreview(null);
    if (!active.dragged) return;
    swallowClick.current = true;
    const target = targetSlot(event, active.item);
    if (!target) return;
    setError("");
    if (active.item) {
      const offset =
        active.mode === "move" && !active.item.allDay
          ? Math.max(
              0,
              active.origin.minute -
                minutesOf(active.item.start!.slice(11, 16)),
            )
          : 0;
      const minute = Math.max(0, target.minute - offset);
      const span = proposedSpan(
        active.item,
        target.day,
        clock(minute),
        zone,
        active.mode,
        settings.increment,
      );
      if (span) void editing.openItem(active.item, span);
      else
        setError(
          "This time range cannot be scheduled. Choose another time or edit the event.",
        );
      return;
    }
    const ordered = [active.origin, target].sort(
      (a, b) => a.day.localeCompare(b.day) || a.minute - b.minute,
    );
    const [start, end] = ordered;
    const endMinute = end.minute + settings.increment;
    editing.openNew({
      ...newDraft(
        start.day,
        zone,
        editing.defaultCalendar,
        clock(start.minute),
        clock(endMinute % MINUTES_PER_DAY),
      ),
      endDate: endMinute === MINUTES_PER_DAY ? addDays(end.day, 1) : end.day,
    });
  }

  function newEvent() {
    const step = settings.increment;
    const start =
      firstShown === today
        ? Math.min(MINUTES_PER_DAY - step, Math.ceil(now / step) * step)
        : minutesOf(settings.workStart);
    createAt(firstShown, start);
  }

  /** Every control of every item in `scope`, in reading order. */
  function controlsIn(scope: ParentNode) {
    return Array.from(
      scope.querySelectorAll<HTMLElement>(
        ".timeline-item :is(a, button), .timeline-band :is(a, button)",
      ),
    );
  }

  /**
   * Keyboard use of events. Arrow keys move focus between items, Alt/Option
   * with arrows proposes moving the focused event by one grid step or one
   * day, and Alt/Option+Shift with Up or Down proposes a new end. A proposal
   * opens the editor with the new times, as a drag does, so nothing changes
   * until it is saved.
   */
  function itemKeys(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    if (
      !(target instanceof HTMLElement) ||
      event.metaKey ||
      event.ctrlKey ||
      !target.closest(".timeline-item, .timeline-band") ||
      ![
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const sign = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
    const handle = target.closest<HTMLElement>("[data-schedule-item]");
    const item = handle
      ? visible.find(({ id }) => id === handle.dataset.scheduleItem)
      : undefined;

    if (event.altKey) {
      if (!item || (event.shiftKey && !vertical) || (!vertical && !horizontal))
        return;
      if (item.allDay && vertical) return;
      event.preventDefault();
      setError("");
      const step = settings.increment;
      // The proposal moves the start, or with Shift the end, by one step
      // or one day, across midnight when it has to.
      const resizing = event.shiftKey;
      const wallTime = resizing ? item.end : item.start;
      const from = item.allDay ? item.startDate : wallTime;
      if (!from) return;
      const day = from.slice(0, 10);
      const minute = item.allDay ? 0 : minutesOf(from.slice(11, 16));
      const total = minute + (vertical && !item.allDay ? sign * step : 0);
      const shifted = addDays(
        day,
        Math.floor(total / MINUTES_PER_DAY) +
          (horizontal || item.allDay ? sign : 0),
      );
      const span = proposedSpan(
        item,
        item.allDay && vertical ? day : shifted,
        clock(((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY),
        zone,
        resizing ? "resize" : "move",
        step,
      );
      if (span) void editing.openItem(item, span);
      else
        setError(
          "This time range cannot be scheduled. Choose another time or edit the event.",
        );
      return;
    }
    if (event.shiftKey) return;

    const column = target.closest<HTMLElement>("[data-schedule-timeline]");
    const scope = column ?? target.closest<HTMLElement>(".timeline-allday");
    const list = scope ? controlsIn(scope) : [];
    const index = list.indexOf(target);
    if (index < 0) return;
    let next: HTMLElement | undefined;
    if (event.key === "Home") next = list[0];
    else if (event.key === "End") next = list[list.length - 1];
    else if (vertical) next = list[index + sign];
    else if (column) {
      // Side to side visits the nearest day that has items.
      const columns = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          "[data-schedule-timeline]",
        ),
      );
      const at = columns.indexOf(column);
      for (let i = at + sign; i >= 0 && i < columns.length; i += sign) {
        const found = controlsIn(columns[i]);
        if (found.length) {
          next = found[Math.min(index, found.length - 1)];
          break;
        }
      }
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
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
        <button
          type="button"
          className="calendar-new-event"
          data-new-event
          onClick={newEvent}
        >
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
        <label className="timeline-grid-setting">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.checked) next.set("closed", "1");
              else next.delete("closed");
              setParams(next);
            }}
          />{" "}
          Show closed issues
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
        onKeyDown={itemKeys}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={() => {
          gesture.current = null;
          setPreview(null);
        }}
        onClickCapture={(event) => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          if (event.detail > 0) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <div className="timeline-head">
          <span className="timeline-corner" aria-hidden="true" />
          {days.map((day) => (
            <div
              key={day}
              className="timeline-day-name"
              data-schedule-day={day}
              data-drop-preview={preview?.to.day === day}
              aria-current={day === today ? "date" : undefined}
              data-workday={settings.workDays.includes(
                parseLocalDate(day).getDay(),
              )}
            >
              {dayName(day, "short")}
              {settings.workDays.includes(parseLocalDate(day).getDay()) && (
                <span className="timeline-free">
                  Free{" "}
                  {freeLabel(
                    availability(
                      visible,
                      workWindow(
                        day,
                        zone,
                        settings.workStart,
                        settings.workEnd,
                      ),
                    ).freeMs,
                  )}
                </span>
              )}
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
              data-closed={item.kind === "deadline" && item.closed}
              data-overdue={
                item.kind === "deadline" &&
                isOverdue(
                  { dueDate: item.startDate, closed: item.closed },
                  today,
                )
              }
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
                  <Flag size={12} aria-hidden="true" />
                  <span className="visually-hidden">
                    {item.closed
                      ? "Completed deadline: "
                      : isOverdue(
                            { dueDate: item.startDate, closed: false },
                            today,
                          )
                        ? "Overdue deadline: "
                        : "Deadline: "}
                  </span>
                  <span className="timeline-band-text">
                    {issueKey({ number: item.issueNumber! })} {item.title}
                  </span>
                </Link>
              ) : (
                <button
                  type="button"
                  data-schedule-item={item.id}
                  title="Drag to a day heading to move"
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
                  data-schedule-day={day}
                  data-schedule-timeline="true"
                  role="group"
                  aria-label={dayName(day, "long")}
                  data-today={day === today}
                  data-workday={settings.workDays.includes(
                    parseLocalDate(day).getDay(),
                  )}
                  onClick={(event) => onDayClick(event, day)}
                >
                  {preview?.to.day === day && (
                    <span
                      className="timeline-gesture-preview"
                      aria-hidden="true"
                      style={{
                        top: `${((preview.from.day === day && preview.selecting ? Math.min(preview.from.minute, preview.to.minute) : preview.to.minute) / MINUTES_PER_DAY) * 100}%`,
                        height: `${((preview.from.day === day && preview.selecting ? Math.abs(preview.from.minute - preview.to.minute) + settings.increment : settings.increment) / MINUTES_PER_DAY) * 100}%`,
                      }}
                    />
                  )}
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
                          conflicts={conflicts.get(block.item.id) ?? []}
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

/** "5 h 30 min" for the free time in a day's working hours. */
function freeLabel(ms: number) {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return (
    [hours ? `${hours} h` : "", minutes % 60 ? `${minutes % 60} min` : ""]
      .filter(Boolean)
      .join(" ") || "0 min"
  );
}

function TimelineBlock({
  block,
  conflicts,
  onOpen,
}: {
  block: Block;
  conflicts: CalendarItem[];
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
  const overlap = conflicts.length > 0 && (
    <span className="visually-hidden">
      {` Overlaps ${conflicts.map(({ title }) => title).join(", ")}.`}
    </span>
  );
  const times = `${block.continuesBefore ? "…" : start}–${block.continuesAfter ? "…" : end}`;
  return (
    <li
      className="timeline-item"
      data-kind={item.kind}
      // Short items put the time and title on one line.
      data-short={bottom - top < 45}
      data-conflict={conflicts.length > 0}
      style={style}
    >
      {item.kind === "workBlock" ? (
        <Link to={`/issues/${item.issueId}`}>
          <span className="timeline-item-time">
            <Timer size={11} aria-hidden="true" /> {times}
          </span>
          <span className="timeline-item-title">
            <span className="visually-hidden">Work block: </span>
            {issueKey({ number: item.issueNumber! })} {item.title}
          </span>
          {overlap}
        </Link>
      ) : (
        <button type="button" onClick={onOpen} data-schedule-item={item.id}>
          {!block.continuesAfter && (
            <span
              className="timeline-resize"
              title="Drag to resize"
              data-resize
              aria-hidden="true"
            />
          )}
          <span className="timeline-item-time">{times}</span>
          <span className="timeline-item-title">
            {item.title}
            {item.recurring && <Repeat size={12} aria-hidden="true" />}
          </span>
          <span className="visually-hidden">
            {`, ${colorName(item) ?? ""} calendar${item.recurring ? ", repeats" : ""}. Edit event.`}
          </span>
          {overlap}
        </button>
      )}
    </li>
  );
}
