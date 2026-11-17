import type { CalendarItem } from "../../database/events";
import { addDays } from "./dates";

export interface Agenda {
  /** All-day events covering today. */
  allDay: CalendarItem[];
  /** Timed events and work blocks on today, earliest first. */
  timed: CalendarItem[];
  /** Open deadlines after today, soonest first. */
  comingUp: CalendarItem[];
}

/**
 * Sorts calendar items read for `today` and a few days after into the
 * agenda. Today's deadlines are not here, since the task list below the
 * agenda already lists them. Closed issues' work blocks stay, so completing
 * a task keeps the history of when it was worked on.
 */
export function buildAgenda(items: CalendarItem[], today: string): Agenda {
  const next = addDays(today, 1);
  const allDay = items.filter(
    (item) =>
      item.kind === "event" &&
      item.allDay &&
      item.startDate! <= today &&
      item.endDate! > today,
  );
  const timed = items
    .filter(
      (item) =>
        item.kind !== "deadline" &&
        !item.allDay &&
        item.start! < `${next}T00:00` &&
        item.end! > `${today}T00:00`,
    )
    .sort(
      (a, b) =>
        a.start!.localeCompare(b.start!) || a.title.localeCompare(b.title),
    );
  const comingUp = items
    .filter(
      (item) =>
        item.kind === "deadline" && !item.closed && item.startDate! > today,
    )
    .sort(
      (a, b) =>
        a.startDate!.localeCompare(b.startDate!) ||
        a.issueNumber! - b.issueNumber!,
    );
  return { allDay, timed, comingUp };
}
