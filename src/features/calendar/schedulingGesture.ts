import type { CalendarItem } from "../../database/events";
import { addDays } from "../today/dates";
import type { OccurrenceSpan } from "./eventDraft";

export type GestureMode = "move" | "resize";

export function wall(instant: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Resolve a visible grid time, choosing the earlier instant in a fold. */
export function instant(wallTime: string, zone: string) {
  const civil = Date.parse(wallTime + "Z");
  const day = 86_400_000;
  const candidates = [civil - day, civil, civil + day]
    .map((sample) => civil + sample - Date.parse(wall(sample, zone) + "Z"))
    .filter((candidate) => wall(candidate, zone) === wallTime);
  return candidates.length ? Math.min(...candidates) : undefined;
}

export function proposedSpan(
  item: CalendarItem,
  day: string,
  time: string,
  zone: string,
  mode: GestureMode,
  minimum: number,
): OccurrenceSpan | undefined {
  if (item.allDay) {
    if (!item.startDate || !item.endDate || mode === "resize") return;
    const length =
      (Date.parse(item.endDate) - Date.parse(item.startDate)) / 86_400_000;
    return { start: day, end: addDays(day, length) };
  }
  if (!item.startAt || !item.endAt || !item.timeZone) return;
  const target = instant(`${day}T${time}`, zone);
  if (target === undefined) return;
  const oldStart = Date.parse(item.startAt);
  const oldEnd = Date.parse(item.endAt);
  const start = mode === "move" ? target : oldStart;
  const end = mode === "move" ? target + oldEnd - oldStart : target;
  const startWall = wall(start, item.timeZone);
  const endWall = wall(end, item.timeZone);
  if (
    end - start < (mode === "resize" ? minimum : 1) * 60_000 ||
    endWall <= startWall
  )
    return;
  // The API resolves overlaps to the earlier instant. Reject a span that
  // cannot round-trip through the event's existing wall-clock contract.
  if (
    instant(startWall, item.timeZone) !== start ||
    instant(endWall, item.timeZone) !== end
  )
    return;
  return { start: startWall, end: endWall };
}
