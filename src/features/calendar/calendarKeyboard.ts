import { shortcutAllowed } from "../issues/issueKeyboard";
import type { CalendarView } from "./ViewSwitch";

/**
 * Calendar shortcuts all use Alt/Option+Shift, like the Issues shortcuts, so
 * they never collide with typing, the system, or the browser, and they are
 * ignored in fields and behind dialogs. N and F are taken by Issues.
 */
export type ShortcutAction =
  | { type: "today" }
  | { type: "step"; direction: 1 | -1 }
  | { type: "view"; view: CalendarView }
  | { type: "goto" }
  | { type: "search" }
  | { type: "new" };

const views: CalendarView[] = ["day", "week", "workweek", "month", "agenda"];

/** What an Alt/Option+Shift key press asks of the calendar, if anything. */
export function shortcutAction(event: KeyboardEvent): ShortcutAction | null {
  if (!shortcutAllowed(event)) return null;
  switch (event.code) {
    case "KeyT":
      return { type: "today" };
    case "Comma":
      return { type: "step", direction: -1 };
    case "Period":
      return { type: "step", direction: 1 };
    case "KeyG":
      return { type: "goto" };
    case "KeyS":
      return { type: "search" };
    case "KeyE":
      return { type: "new" };
  }
  const digit = /^Digit([1-5])$/.exec(event.code);
  return digit ? { type: "view", view: views[Number(digit[1]) - 1] } : null;
}

/** Shown in the shortcut help and in docs/CALENDAR.md. */
export const shortcutHelp: [keys: string, what: string][] = [
  ["T", "Go to today"],
  [",  and  .", "Previous and next day, week, or month"],
  ["1 to 5", "Day, Week, Workweek, Month, or Agenda"],
  ["G", "Focus Go to date"],
  ["S", "Focus search"],
  ["E", "New event"],
];
