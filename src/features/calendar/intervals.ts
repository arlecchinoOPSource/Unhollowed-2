import type { CalendarItem } from "../../database/events";
import { addDays } from "../today/dates";
import { instant, wall } from "./schedulingGesture";
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

/**
 * Instant spans, in milliseconds, are what conflicts and availability use,
 * since two wall-clock times can name the same moment or none on a
 * daylight-saving day. Every range is half-open, so an item that ends when
 * another starts does not overlap it.
 */
export function instantSpan(item: CalendarItem): Span | null {
  if (item.allDay || !item.startAt || !item.endAt) return null;
  const start = Date.parse(item.startAt);
  const end = Date.parse(item.endAt);
  return end > start ? [start, end] : null;
}

/** Whether two half-open spans share any time. Touching ends do not. */
export function overlaps(a: Span, b: Span): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * The timed items that overlap each other, by item ID. All-day events never
 * conflict: they mark a day without occupying time on it.
 */
export function conflictsOf(
  items: CalendarItem[],
): Map<string, CalendarItem[]> {
  const timed = items.flatMap((item) => {
    const span = instantSpan(item);
    return span ? [{ item, span }] : [];
  });
  const found = new Map<string, CalendarItem[]>();
  for (const [index, a] of timed.entries())
    for (const b of timed.slice(index + 1))
      if (overlaps(a.span, b.span)) {
        found.set(a.item.id, [...(found.get(a.item.id) ?? []), b.item]);
        found.set(b.item.id, [...(found.get(b.item.id) ?? []), a.item]);
      }
  return found;
}

/**
 * The instant a wall-clock time (`YYYY-MM-DDTHH:MM`) is in `zone`. A time
 * that does not exist because clocks jumped forward resolves to the first
 * moment after the gap, and a repeated time to its first occurrence.
 */
export function wallInstant(wallTime: string, zone: string): number {
  const exact = instant(wallTime, zone);
  if (exact !== undefined) return exact;
  // In a gap, apply the offset in force just before it.
  const base = Date.parse(`${wallTime}Z`);
  for (let minutes = 1; minutes <= 180; minutes++) {
    const before = base - minutes * 60_000;
    const found = instant(new Date(before).toISOString().slice(0, 16), zone);
    if (found !== undefined) return base - (before - found);
  }
  return base;
}

/** The working-hours window on `day` as instants. */
export function workWindow(
  day: string,
  zone: string,
  workStart: string,
  workEnd: string,
): Span {
  return [
    wallInstant(`${day}T${workStart}`, zone),
    wallInstant(`${day}T${workEnd}`, zone),
  ];
}

/**
 * Free time inside working hours on `day`: the window, from `notBefore` if
 * later, minus timed items. Hidden or archived items never reach here, since
 * reads leave them out. All-day events do not reduce availability.
 */
export function availability(
  items: CalendarItem[],
  window: Span,
  notBefore = 0,
): { free: Span[]; freeMs: number } {
  const busy = items.flatMap((item) => {
    const span = instantSpan(item);
    return span ? [span] : [];
  });
  const free = freeSpans(busy, Math.max(window[0], notBefore), window[1]);
  return {
    free,
    freeMs: free.reduce((sum, [start, end]) => sum + end - start, 0),
  };
}

/** `HH:MM` of an instant on the viewer's wall clock. */
export function clockAt(ms: number, zone: string): string {
  return wall(ms, zone).slice(11);
}
