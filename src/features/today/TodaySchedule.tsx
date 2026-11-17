import { CalendarPlus, Flag, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { schedulingError } from "../../database/calendars";
import {
  getEventLinks,
  listCalendarItems,
  type CalendarItem,
  type LinkedRecord,
} from "../../database/events";
import { issueKey } from "../../database/issues";
import { newDraft } from "../calendar/eventDraft";
import {
  availability,
  busySpan,
  clockAt,
  workWindow,
} from "../calendar/intervals";
import { fullDate } from "../calendar/monthGrid";
import { displayClock, useCalendarPreferences } from "../calendar/preferences";
import { clock } from "../calendar/timeline";
import { useDeviceZone } from "../calendar/useDeviceZone";
import { useEventEditing } from "../calendar/useEventEditing";
import { buildAgenda } from "./agenda";
import { addDays, parseLocalDate } from "./dates";

/** Days after today whose deadlines are listed under Coming up. */
const LOOKAHEAD = 3;

function minutesToHours(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} h` : "", rest ? `${rest} min` : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * The day's commitments above Today's tasks: all-day events, timed events and
 * work blocks, the time still free inside working hours, and deadlines in
 * the next few days. It reads the same calendar items as the calendar views,
 * so nothing here is stored separately. Overdue and due-today issues are in
 * the task list below, which takes priority over the later deadlines here.
 */
export function TodaySchedule({ today }: { today: string }) {
  const zone = useDeviceZone();
  const settings = useCalendarPreferences();
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [links, setLinks] = useState<Record<string, LinkedRecord[]>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // Bumped when the window regains focus, so a resumed app reloads.
  const [request, setRequest] = useState(0);
  const editing = useEventEditing({
    onMessage: setMessage,
    onChanged: () => setRequest((value) => value + 1),
  });

  useEffect(() => {
    const refresh = () => setRequest((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    let current = true;
    listCalendarItems(today, addDays(today, LOOKAHEAD + 1), zone).then(
      async ({ items: loaded }) => {
        const todays = buildAgenda(loaded, today);
        const events = [...todays.allDay, ...todays.timed].filter(
          (item) => item.kind === "event",
        );
        // Project context for events. A failed read leaves them unlabeled.
        const found = await Promise.all(
          events.map((item) =>
            getEventLinks(item.eventId!).then(
              ({ projects }) => [item.eventId!, projects] as const,
              () => [item.eventId!, []] as const,
            ),
          ),
        );
        if (!current) return;
        setError("");
        setLinks(Object.fromEntries(found));
        setItems(loaded);
      },
      (cause) => current && setError(schedulingError(cause)),
    );
    return () => {
      current = false;
    };
  }, [today, zone, request]);

  const agenda = items && buildAgenda(items, today);
  const workDay = settings.workDays.includes(parseLocalDate(today).getDay());
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const { free, freeMs } =
    agenda && workDay
      ? availability(
          agenda.timed,
          workWindow(today, zone, settings.workStart, settings.workEnd),
          now.getTime(),
        )
      : { free: [], freeMs: 0 };
  const shown = free.filter(
    ([start, end]) => end - start >= settings.increment * 60_000,
  );

  function times(item: CalendarItem) {
    const span = busySpan(item, today);
    return span
      ? `${displayClock(clock(span[0]), settings.twelveHour)}–${displayClock(clock(span[1] % 1440), settings.twelveHour)}`
      : "";
  }

  function name(item: CalendarItem) {
    return item.kind === "workBlock" ? (
      <Link to={`/issues/${item.issueId}`}>
        <Timer size={13} aria-hidden="true" />{" "}
        <span className="visually-hidden">Work block: </span>
        {issueKey({ number: item.issueNumber! })} {item.title}
      </Link>
    ) : (
      <button type="button" onClick={() => void editing.openItem(item)}>
        {item.title}
      </button>
    );
  }

  function context(item: CalendarItem) {
    const projects = (item.eventId && links[item.eventId]) || [];
    return projects.length > 0 ? (
      <span className="agenda-projects">
        {projects.map(({ id, title, archived }) => (
          <Link key={id} to={`/projects/${id}`}>
            {title}
            {archived ? " (archived)" : ""}
          </Link>
        ))}
      </span>
    ) : null;
  }

  return (
    <section className="today-schedule" aria-labelledby="today-schedule-title">
      <div className="today-schedule-head">
        <h2 id="today-schedule-title">Schedule</h2>
        <button
          type="button"
          className="action"
          onClick={() =>
            editing.openNew(
              newDraft(
                today,
                zone,
                editing.defaultCalendar,
                clock(Math.min(1380, Math.ceil(nowMinutes / 30) * 30)),
                clock(Math.min(1439, Math.ceil(nowMinutes / 30) * 30 + 60)),
              ),
            )
          }
        >
          <CalendarPlus size={15} aria-hidden="true" /> New event
        </button>
        <Link to={`/calendar?view=day&date=${today}`}>Plan the day</Link>
      </div>
      {(error || editing.error) && <p role="alert">{error || editing.error}</p>}
      <p role="status">{message}</p>
      {!agenda && !error && <p>Loading schedule…</p>}
      {agenda && (
        <>
          {agenda.allDay.length + agenda.timed.length === 0 ? (
            <p>No events or work blocks today.</p>
          ) : (
            <ul className="agenda-list" aria-label="Today's events">
              {agenda.allDay.map((item) => (
                <li key={item.id}>
                  <span className="agenda-time">All day</span> {name(item)}{" "}
                  {context(item)}
                </li>
              ))}
              {agenda.timed.map((item) => (
                <li
                  key={item.id}
                  data-kind={item.kind}
                  data-closed={item.closed}
                >
                  <span className="agenda-time">{times(item)}</span>{" "}
                  {name(item)} {item.closed && <span>(issue completed)</span>}
                  {context(item)}
                </li>
              ))}
            </ul>
          )}
          <p>
            {!workDay
              ? "Today is not a working day."
              : shown.length === 0
                ? "No free time left in working hours."
                : `Free in working hours: ${minutesToHours(Math.round(freeMs / 60_000))}, ${shown
                    .map(
                      ([start, end]) =>
                        `${displayClock(clockAt(start, zone), settings.twelveHour)}–${displayClock(clockAt(end, zone), settings.twelveHour)}`,
                    )
                    .join(", ")}.`}
          </p>
          {agenda.comingUp.length > 0 && (
            <>
              <h3>Coming up</h3>
              <ul className="agenda-list" aria-label="Upcoming deadlines">
                {agenda.comingUp.map((item) => (
                  <li key={item.id}>
                    <span className="agenda-time">
                      {fullDate(item.startDate!)}
                    </span>{" "}
                    <Link to={`/issues/${item.issueId}`}>
                      <Flag size={13} aria-hidden="true" />{" "}
                      <span className="visually-hidden">Deadline: </span>
                      {issueKey({ number: item.issueNumber! })} {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {editing.editor}
    </section>
  );
}
