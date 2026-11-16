import { addDays, parseLocalDate } from "../today/dates";

/**
 * Month grid arithmetic on local calendar dates (YYYY-MM-DD). Like Today and
 * Upcoming, the calendar never converts due dates to instants, so a date
 * shows on the same day in every time zone and across daylight saving.
 */

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The YYYY-MM month containing a YYYY-MM-DD date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Returns `value` if it is a valid YYYY-MM month, otherwise `fallback`. */
export function readMonth(value: string | null, fallback: string): string {
  return value && MONTH.test(value) && value >= "0001-01" ? value : fallback;
}

export function shiftMonth(month: string, months: number): string {
  const [year, index] = month.split("-").map(Number);
  const total = year * 12 + (index - 1) + months;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function daysInMonth(month: string): number {
  const [year, index] = month.split("-").map(Number);
  return new Date(year, index, 0).getDate();
}

/**
 * The 42 dates (six weeks) shown for `month`, starting on the week start on
 * or before the first of the month. Weeks start on Monday.
 */
export function gridDays(month: string): string[] {
  const first = `${month}-01`;
  // getDay: 0 is Sunday. Days back to the previous Monday.
  const back = (parseLocalDate(first).getDay() + 6) % 7;
  const start = addDays(first, -back);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

/** The same day of the month `months` away, clamped to that month's length. */
export function shiftDateByMonths(date: string, months: number): string {
  const month = shiftMonth(monthOf(date), months);
  const day = Math.min(Number(date.slice(8, 10)), daysInMonth(month));
  return `${month}-${String(day).padStart(2, "0")}`;
}

export function monthTitle(month: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(parseLocalDate(`${month}-01`));
}

export function fullDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parseLocalDate(date));
}

/** Weekday names in grid order, from Monday. */
export function weekdayNames(style: "short" | "long"): string[] {
  // 2026-11-16 is a Monday.
  return Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(undefined, { weekday: style }).format(
      parseLocalDate(addDays("2026-11-16", index)),
    ),
  );
}
