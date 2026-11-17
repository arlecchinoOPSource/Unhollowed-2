import { displayClock, useCalendarPreferences } from "./preferences";
import { CalendarPlus, Repeat } from "lucide-react";
import { useEffect, useState } from "react";
import { calendarColors, schedulingError } from "../../database/calendars";
import { listCalendarItems, type CalendarItem } from "../../database/events";
import { swatchStyle } from "../labels/LabelParts";
import { addDays } from "../today/dates";
import { newDraft } from "./eventDraft";
import { useEventEditing } from "./useEventEditing";
import { timeIn, useDeviceZone } from "./useDeviceZone";

/** `09:00–10:30`, or the dates for items that cross midnight. */
function timeRange(item: CalendarItem, day: string, twelveHour: boolean) {
  if (item.allDay) return "All day";
  const [startDay, start] = (item.start ?? "").split("T");
  const [endDay, end] = (item.end ?? "").split("T");
  const from =
    startDay === day
      ? displayClock(start, twelveHour)
      : `${startDay} ${displayClock(start, twelveHour)}`;
  const to =
    endDay === day
      ? displayClock(end, twelveHour)
      : `${endDay} ${displayClock(end, twelveHour)}`;
  return `${from}–${to}`;
}

/**
 * The selected day's events, with a button to add one. Each event opens the
 * shared event editor.
 */
export function DayEvents({
  day,
  onMessage,
  revision = 0,
  onChanged,
}: {
  day: string;
  revision?: number;
  onChanged?: () => void;
  onMessage: (message: string) => void;
}) {
  const { twelveHour } = useCalendarPreferences();
  const zone = useDeviceZone();
  const [items, setItems] = useState<{ day: string; list: CalendarItem[] }>();
  const [loadError, setLoadError] = useState("");
  const [request, setRequest] = useState(0);
  const editing = useEventEditing({
    onMessage,
    onChanged: () => {
      setRequest((value) => value + 1);
      onChanged?.();
    },
  });

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
        if (current) setLoadError(schedulingError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [day, zone, request, revision]);

  const list = items?.day === day ? items.list : null;
  const error = loadError || editing.error;

  return (
    <div className="calendar-day-events">
      <div className="calendar-day-events-head">
        <h3>Events</h3>
        <button
          type="button"
          className="calendar-new-event"
          onClick={() =>
            editing.openNew(newDraft(day, zone, editing.defaultCalendar))
          }
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
              <button type="button" onClick={() => void editing.openItem(item)}>
                <span
                  className="label-dot"
                  aria-hidden="true"
                  style={swatchStyle(
                    (item.color ?? "gray") as keyof typeof calendarColors,
                  )}
                />
                <span className="calendar-event-time">
                  {timeRange(item, day, twelveHour)}
                </span>
                <span>{item.title}</span>
                {item.recurring && (
                  <span className="calendar-event-repeat">
                    <Repeat size={13} aria-hidden="true" />
                    <span className="visually-hidden">Repeats</span>
                  </span>
                )}
                {item.timeZone && item.startAt && item.timeZone !== zone && (
                  <span className="calendar-event-zone">
                    {timeIn(item.startAt, item.timeZone)} {item.timeZone}
                  </span>
                )}
                <span className="visually-hidden">
                  {`, ${calendarColors[item.color as keyof typeof calendarColors]?.name ?? ""} calendar. Edit event.`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing.editor}
    </div>
  );
}
