/**
 * Local calendar date helpers for Today and Upcoming.
 *
 * Due dates are plain local dates (YYYY-MM-DD), so the views compare date
 * strings in the device's current time zone and never convert to UTC
 * instants. Building dates from local year, month, and day fields keeps
 * them correct on 23- and 25-hour daylight-saving days.
 */

/** The local calendar date `days` after `from`, as YYYY-MM-DD. */
export function localDate(from: Date, days = 0): string {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses YYYY-MM-DD as local midnight on that date. */
export function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** The local date `days` after the YYYY-MM-DD `date`. */
export function addDays(date: string, days: number): string {
  return localDate(parseLocalDate(date), days);
}

/**
 * Milliseconds until the next local midnight. On a daylight-saving change
 * the local day is 23 or 25 hours long, so this is not always 24 hours.
 */
export function msUntilNextLocalMidnight(now: Date): number {
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  return Math.max(0, midnight.getTime() - now.getTime());
}

/** A heading for a due date relative to `today`. */
export function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  const value = parseLocalDate(date);
  const sameYear = value.getFullYear() === parseLocalDate(today).getFullYear();
  // Weekday names alone only make sense for the coming week. Past dates,
  // such as overdue ones, always include the month and day.
  const within = date > today && date <= addDays(today, 6);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    ...(within ? {} : { month: "short", day: "numeric" }),
    ...(within || sameYear ? {} : { year: "numeric" }),
  }).format(value);
}
