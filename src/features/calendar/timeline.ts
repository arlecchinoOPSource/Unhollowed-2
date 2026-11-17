import type { CalendarItem } from "../../database/events";
import { addDays, parseLocalDate } from "../today/dates";
import type { CalendarSettings } from "./settings";

/**
 * Timeline arithmetic for the Day, Week, and Workweek views. Days are local
 * calendar dates in the viewer's zone, and timed items are placed by their
 * wall-clock times there, so a 23- or 25-hour daylight-saving day still
 * shows 24 hour rows: the hour that does not exist stays empty, and the
 * repeated hour shows both of its items in the same row.
 */

export type TimelineView = "day" | "week" | "workweek";

export const MINUTES_PER_DAY = 1440;

/** Minutes after midnight of `HH:MM`. */
export function minutesOf(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

/** The first day of the week containing `date`. */
export function weekStartOf(date: string, weekStart: number): string {
  const back = (parseLocalDate(date).getDay() - weekStart + 7) % 7;
  return addDays(date, -back);
}

/** The dates a view shows around `date`. */
export function viewDays(
  view: TimelineView,
  date: string,
  settings: CalendarSettings,
): string[] {
  if (view === "day") return [date];
  const start = weekStartOf(date, settings.weekStart);
  const week = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  if (view === "week") return week;
  const days = week.filter((day) =>
    settings.workDays.includes(parseLocalDate(day).getDay()),
  );
  // With no working days configured, show the whole week rather than none.
  return days.length ? days : week;
}

/** The date one step before or after, for Previous and Next. */
export function stepDate(view: TimelineView, date: string, direction: 1 | -1) {
  return addDays(date, direction * (view === "day" ? 1 : 7));
}

/** A timed item's part on one day, placed for the grid. */
export interface Block {
  item: CalendarItem;
  /** Minutes after midnight, clipped to the day. */
  top: number;
  bottom: number;
  /** Whether the item continues from the day before or onto the next. */
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** Side-by-side position among overlapping blocks. */
  column: number;
  columns: number;
}

/** Shortest drawn length, so short items stay readable and clickable. */
const MIN_MINUTES = 20;

/**
 * Timed items on `day`, clipped to it and laid out in columns. Overlapping
 * items form a cluster that shares the width: each takes the first column
 * free at its start, and the cluster uses as many columns as it needs.
 */
export function layoutDay(items: CalendarItem[], day: string): Block[] {
  const next = addDays(day, 1);
  const parts = items
    .filter(
      (item) =>
        !item.allDay &&
        item.start &&
        item.end &&
        item.start < `${next}T00:00` &&
        item.end > `${day}T00:00`,
    )
    .map((item) => {
      const startsBefore = item.start!.slice(0, 10) < day;
      const endsAfter = item.end! >= `${next}T00:00`;
      const top = startsBefore ? 0 : minutesOf(item.start!.slice(11));
      const bottom = endsAfter
        ? MINUTES_PER_DAY
        : minutesOf(item.end!.slice(11));
      return {
        item,
        top,
        bottom: Math.min(MINUTES_PER_DAY, Math.max(bottom, top + MIN_MINUTES)),
        continuesBefore: startsBefore,
        continuesAfter: endsAfter,
        column: 0,
        columns: 1,
      };
    })
    .sort(
      (a, b) =>
        a.top - b.top ||
        b.bottom - a.bottom ||
        a.item.title.localeCompare(b.item.title) ||
        a.item.id.localeCompare(b.item.id),
    );

  let cluster: Block[] = [];
  let clusterEnd = -1;
  const finish = () => {
    const columns = Math.max(1, ...cluster.map(({ column }) => column + 1));
    for (const block of cluster) block.columns = columns;
    cluster = [];
  };
  for (const block of parts) {
    if (block.top >= clusterEnd) {
      finish();
      clusterEnd = -1;
    }
    // The first column whose last block has ended.
    const taken = cluster.filter((other) => other.bottom > block.top);
    let column = 0;
    while (taken.some((other) => other.column === column)) column += 1;
    block.column = column;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.bottom);
  }
  finish();
  return parts;
}

/** A date-only item's run across the shown days. */
export interface Band {
  item: CalendarItem;
  /** Index of the first and last shown day it covers. */
  first: number;
  last: number;
  /** Row in the all-day area, so runs do not overlap. */
  row: number;
}

/**
 * All-day events and deadlines across `days`, each on the first row that is
 * free for every day it covers. Days may skip weekends (Workweek), so a run
 * covers the shown days that fall inside it.
 */
export function layoutAllDay(items: CalendarItem[], days: string[]): Band[] {
  const bands: Band[] = [];
  const rows: number[][] = [];
  const dated = items
    .filter((item) => item.allDay && item.startDate)
    .map((item) => {
      const end = item.endDate ?? addDays(item.startDate!, 1);
      const covered = days
        .map((day, index) => ({ day, index }))
        .filter(({ day }) => day >= item.startDate! && day < end);
      return { item, covered };
    })
    .filter(({ covered }) => covered.length > 0)
    .sort(
      (a, b) =>
        a.covered[0].index - b.covered[0].index ||
        b.covered.length - a.covered.length ||
        a.item.title.localeCompare(b.item.title),
    );
  for (const { item, covered } of dated) {
    const first = covered[0].index;
    const last = covered[covered.length - 1].index;
    let row = 0;
    while (rows[row]?.some((used) => used >= first && used <= last) ?? false)
      row += 1;
    rows[row] = [...(rows[row] ?? []), ...covered.map(({ index }) => index)];
    bands.push({ item, first, last, row });
  }
  return bands;
}

/** `HH:MM` for a minute of the day, `24:00` included. */
export function clock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  return `${String(hour).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "November 16 – 22, 2026", or a single long date for one day. */
export function rangeTitle(days: string[]): string {
  const first = parseLocalDate(days[0]);
  const last = parseLocalDate(days[days.length - 1]);
  if (days.length === 1)
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(first);
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).formatRange(first, last);
}
