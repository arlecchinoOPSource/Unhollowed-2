import { CalendarPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  calendarColors,
  listCalendars,
  schedulingError,
  type Calendar,
} from "../../database/calendars";
import {
  getEvent,
  listCalendarItems,
  type CalendarEvent,
  type CalendarItem,
} from "../../database/events";
import { swatchStyle } from "../labels/LabelParts";
import { addDays } from "../today/dates";
import { EventEditor, type EventChange } from "./EventEditor";
import { newDraft, type Draft } from "./eventDraft";
import { timeIn, useDeviceZone } from "./useDeviceZone";

const messages: Record<EventChange, (title: string) => string> = {
  created: (title) => `Created event ${title}.`,
  updated: (title) => `Saved event ${title}.`,
  duplicated: (title) => `Duplicated event ${title}.`,
  deleted: (title) => `Deleted event ${title}.`,
};

/** `09:00–10:30`, or the dates for items that cross midnight. */
function timeRange(item: CalendarItem, day: string) {
  if (item.allDay) return "All day";
  const [startDay, start] = (item.start ?? "").split("T");
  const [endDay, end] = (item.end ?? "").split("T");
  const from = startDay === day ? start : `${startDay} ${start}`;
  const to = endDay === day ? end : `${endDay} ${end}`;
  return `${from}–${to}`;
}

/**
 * The selected day's events, with a button to add one. Each event opens the
 * shared event editor.
 */
export function DayEvents({
  day,
  onMessage,
}: {
  day: string;
  onMessage: (message: string) => void;
}) {
  const zone = useDeviceZone();
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [items, setItems] = useState<{ day: string; list: CalendarItem[] }>();
  const [error, setError] = useState("");
  const [request, setRequest] = useState(0);
  const [editing, setEditing] = useState<{
    event: CalendarEvent | null;
    draft: Draft;
  } | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let current = true;
    listCalendars().then(
      (loaded) => {
        if (current) setCalendars(loaded);
      },
      (cause) => {
        if (current) setError(schedulingError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [request]);

  useEffect(() => {
    let current = true;
    listCalendarItems(day, addDays(day, 1), zone).then(
      ({ items }) => {
        if (current)
          setItems({
            day,
            list: items.filter(({ kind }) => kind === "event"),
          });
      },
      (cause) => {
        if (current) setError(schedulingError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [day, zone, request]);

  const defaultCalendar =
    calendars.find(({ isDefault }) => isDefault)?.id ?? "";

  function open(event: CalendarEvent | null) {
    opener.current = document.activeElement as HTMLElement | null;
    setEditing({ event, draft: newDraft(day, zone, defaultCalendar) });
  }

  async function edit(item: CalendarItem) {
    setError("");
    try {
      open(await getEvent(item.id));
    } catch (cause) {
      setError(schedulingError(cause));
      setRequest((value) => value + 1);
    }
  }

  const list = items?.day === day ? items.list : null;
  const colorName = (item: CalendarItem) =>
    calendarColors[item.color as keyof typeof calendarColors]?.name;

  return (
    <div className="calendar-day-events">
      <div className="calendar-day-events-head">
        <h3>Events</h3>
        <button
          type="button"
          className="calendar-new-event"
          onClick={() => open(null)}
        >
          <CalendarPlus size={15} aria-hidden="true" /> New event
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {list === null && !error && <p>Loading events…</p>}
      {list?.length === 0 && <p>No events this day.</p>}
      {list && list.length > 0 && (
        <ul className="calendar-event-list">
          {list.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => void edit(item)}>
                <span
                  className="label-dot"
                  aria-hidden="true"
                  style={swatchStyle(
                    (item.color ?? "gray") as keyof typeof calendarColors,
                  )}
                />
                <span className="calendar-event-time">
                  {timeRange(item, day)}
                </span>
                <span>{item.title}</span>
                {item.timeZone && item.startAt && item.timeZone !== zone && (
                  <span className="calendar-event-zone">
                    {timeIn(item.startAt, item.timeZone)} {item.timeZone}
                  </span>
                )}
                <span className="visually-hidden">
                  {`, ${colorName(item) ?? ""} calendar. Edit event.`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <EventEditor
          event={editing.event}
          draft={editing.draft}
          calendars={calendars}
          onClose={() => {
            setEditing(null);
            // The editor's opener may have been replaced by a reload.
            requestAnimationFrame(() => {
              if (opener.current?.isConnected) opener.current.focus();
            });
          }}
          onChange={(change, event) => {
            onMessage(messages[change](event.title));
            setRequest((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
