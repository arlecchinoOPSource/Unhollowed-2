import type { CalendarItem } from "../../database/events";
import { addDays } from "../today/dates";
import { MINUTES_PER_DAY, minutesOf } from "./timeline";

/** A span of minutes after midnight, end exclusive. */
export type Span = [start: number, end: number];

/**
 * The part of a timed item that falls on `day`, in the viewer's wall clock,
 * or null when it misses the day or is all-day. Shared by the Today agenda
 * and conflict checks, so both agree on what is busy.
 */
export function busySpan(item: CalendarItem, day: string): Span | null {
  if (item.allDay || !item.start || !item.end) return null;
  const next = addDays(day, 1);
  if (item.start >= `${next}T00:00` || item.end <= `${day}T00:00`) return null;
  const start =
    item.start.slice(0, 10) < day ? 0 : minutesOf(item.start.slice(11));
  const end =
    item.end >= `${next}T00:00`
      ? MINUTES_PER_DAY
      : minutesOf(item.end.slice(11));
  return end > start ? [start, end] : null;
}

/** Overlapping or touching spans merged, in order. */
export function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** The gaps inside `[from, to)` that no busy span covers. */
export function freeSpans(busy: Span[], from: number, to: number): Span[] {
  const free: Span[] = [];
  let cursor = from;
  for (const [start, end] of mergeSpans(busy)) {
    if (end <= cursor) continue;
    if (start >= to) break;
    if (start > cursor) free.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < to) free.push([cursor, to]);
  return free;
}
