import { useEffect, useState } from "react";
import { deviceZone, listCalendarItems } from "../../database/events";
import { addDays } from "../today/dates";
import type { Draft } from "./eventDraft";
import { instantSpan, overlaps, wallInstant } from "./intervals";
import { useCalendarPreferences } from "./preferences";

/**
 * Titles of other timed items a draft overlaps, for an advisory notice.
 * Saving is never blocked. Items that only touch the draft's start or end
 * do not count, and the event being edited is ignored. Reads skip hidden
 * and archived calendars, so those never warn.
 */
export function useOverlapWarning(
  draft: Draft,
  eventId: string | undefined,
): string[] {
  const { warnOverlaps } = useCalendarPreferences();
  const [found, setFound] = useState<{ key: string; titles: string[] }>({
    key: "",
    titles: [],
  });
  const { allDay, startDate, startTime, endDate, endTime, timeZone } = draft;
  const key = JSON.stringify([
    warnOverlaps,
    allDay,
    startDate,
    startTime,
    endDate,
    endTime,
    timeZone,
    eventId,
  ]);

  useEffect(() => {
    if (!warnOverlaps || allDay || !startDate || !endDate) return;
    if (!startTime || !endTime || !timeZone) return;
    const span: [number, number] = [
      wallInstant(`${startDate}T${startTime}`, timeZone),
      wallInstant(`${endDate}T${endTime}`, timeZone),
    ];
    if (!(span[1] > span[0]) || endDate < startDate) return;
    let current = true;
    const timer = window.setTimeout(() => {
      listCalendarItems(startDate, addDays(endDate, 1), deviceZone()).then(
        ({ items }) => {
          if (!current) return;
          const titles = items
            .filter((item) => !eventId || item.eventId !== eventId)
            .filter((item) => {
              const other = instantSpan(item);
              return other && overlaps(span, other);
            })
            .map(({ title }) => title);
          setFound({ key, titles });
        },
        () => undefined,
      );
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [
    key,
    warnOverlaps,
    allDay,
    startDate,
    startTime,
    endDate,
    endTime,
    timeZone,
    eventId,
  ]);

  return found.key === key ? found.titles : [];
}
