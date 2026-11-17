import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useLocalToday } from "../today/useLocalToday";
import "../issues/issues.css";
import { shiftDateByMonths } from "./monthGrid";
import { shortcutAction, shortcutHelp } from "./calendarKeyboard";
import { useCalendarPreferences, validDate } from "./preferences";
import { stepDate } from "./timeline";
import { readView, switchedParams } from "./ViewSwitch";

const names = {
  day: "Day",
  week: "Week",
  workweek: "Workweek",
  month: "Month",
  agenda: "Agenda",
};

/**
 * The calendar's keyboard shortcuts, their announcements, and a help list.
 * Shortcuts change the URL like the on-screen controls do, so the view,
 * date, and history behave the same either way. A polite status announces
 * what a shortcut did, since a view change moves no focus.
 */
export function CalendarShortcuts() {
  const [, setParams] = useSearchParams();
  const today = useLocalToday();
  const preferred = useCalendarPreferences().view;
  const [announcement, setAnnouncement] = useState("");
  // The listener is added once and reads the latest values, and the address
  // bar for the view and date, so quick key presses never act on a stale
  // render.
  const latest = useRef({ setParams, today, preferred });
  useEffect(() => {
    latest.current = { setParams, today, preferred };
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const action = shortcutAction(event);
      if (!action) return;
      const { setParams, today, preferred } = latest.current;
      const params = new URLSearchParams(window.location.search);
      const view = readView(params, preferred);
      const requested = params.get("date");
      const date = validDate(requested) ? requested : today;
      const monthly = view === "month" || view === "agenda";
      event.preventDefault();
      switch (action.type) {
        case "today":
          setParams(switchedParams(params, view, today));
          setAnnouncement(`Showing today in ${names[view]} view.`);
          break;
        case "step": {
          const next = monthly
            ? shiftDateByMonths(date, action.direction)
            : stepDate(view, date, action.direction);
          setParams(switchedParams(params, view, next));
          break;
        }
        case "view":
          setParams(switchedParams(params, action.view, date));
          setAnnouncement(`${names[action.view]} view.`);
          break;
        case "goto":
          document.getElementById("calendar-go-to-date")?.focus();
          break;
        case "search": {
          // The search opens from a button, which focuses its field.
          const field = document.querySelector<HTMLElement>(
            "[data-calendar-search]",
          );
          if (field) field.focus();
          else
            document
              .querySelector<HTMLElement>("[data-calendar-search-toggle]")
              ?.click();
          break;
        }
        case "new": {
          // Focus first, so closing the editor returns focus to the button.
          const button =
            document.querySelector<HTMLElement>("[data-new-event]");
          button?.focus();
          button?.click();
          break;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <p role="status" className="visually-hidden">
        {announcement}
      </p>
      <details className="issue-shortcuts calendar-shortcuts">
        <summary>Keyboard shortcuts</summary>
        <ul>
          {shortcutHelp.map(([keys, what]) => (
            <li key={keys}>
              <kbd>Alt/Option</kbd> + <kbd>Shift</kbd> + <kbd>{keys}</kbd> to{" "}
              {what.charAt(0).toLowerCase() + what.slice(1)}
            </li>
          ))}
          <li>
            <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> to move between
            events in Day, Week, and Workweek, or between days in Month
          </li>
          <li>
            <kbd>Enter</kbd> to open the focused event, and <kbd>Escape</kbd> to
            close it and return to where you were
          </li>
          <li>
            <kbd>Alt/Option</kbd> + arrow keys on an event to propose moving it
            by one grid step or one day, and <kbd>Alt/Option</kbd> +{" "}
            <kbd>Shift</kbd> + <kbd>↑</kbd> <kbd>↓</kbd> to propose a different
            end. The editor opens with the new time to review and save.
          </li>
          <li>
            Shortcuts are off while typing in a field or a dialog is open.
          </li>
        </ul>
      </details>
    </>
  );
}
