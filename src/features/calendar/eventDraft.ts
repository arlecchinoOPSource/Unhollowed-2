import type { CalendarEvent, EventInput } from "../../database/events";
import { addDays } from "../today/dates";

/**
 * The editor's form state, as the strings its inputs hold. All-day events
 * show an inclusive last day, as people expect, and the API stores an
 * exclusive end, so the two convert here and nowhere else.
 */
export interface Draft {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timeZone: string;
  calendarId: string;
  location: string;
  url: string;
  description: string;
}

/** A new draft on `date`, from `start` to `end` (`HH:MM`) by default. */
export function newDraft(
  date: string,
  timeZone: string,
  calendarId: string,
  start = "09:00",
  end = "10:00",
): Draft {
  return {
    title: "",
    allDay: false,
    startDate: date,
    startTime: start,
    endDate: end > start ? date : addDays(date, 1),
    endTime: end,
    timeZone,
    calendarId,
    location: "",
    url: "",
    description: "",
  };
}

export function draftFromEvent(
  event: CalendarEvent,
  fallbackZone: string,
): Draft {
  const [startDate, startTime] = (event.startLocal ?? "").split("T");
  const [endDate, endTime] = (event.endLocal ?? "").split("T");
  return {
    title: event.title,
    allDay: event.allDay,
    startDate: event.allDay ? event.startDate! : startDate,
    startTime: event.allDay ? "09:00" : startTime,
    endDate: event.allDay ? addDays(event.endDate!, -1) : endDate,
    endTime: event.allDay ? "10:00" : endTime,
    timeZone: event.timeZone ?? fallbackZone,
    calendarId: event.calendarId,
    location: event.location ?? "",
    url: event.url ?? "",
    description: event.description,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/** Builds the API input, or explains what to fix. Rust checks it again. */
export function toInput(
  draft: Draft,
): { input: EventInput; error?: never } | { error: string; input?: never } {
  const title = draft.title.trim();
  if (!title) return { error: "Enter a title." };
  if (!DATE.test(draft.startDate) || !DATE.test(draft.endDate))
    return { error: "Enter a start and end date." };
  const common = {
    calendarId: draft.calendarId || null,
    title,
    description: draft.description,
    location: draft.location.trim() || null,
    url: draft.url.trim() || null,
  };
  if (draft.allDay) {
    if (draft.endDate < draft.startDate)
      return { error: "End on or after the start date." };
    return {
      input: {
        ...common,
        allDay: true,
        startDate: draft.startDate,
        endDate: addDays(draft.endDate, 1),
      },
    };
  }
  if (!TIME.test(draft.startTime) || !TIME.test(draft.endTime))
    return { error: "Enter a start and end time." };
  const start = `${draft.startDate}T${draft.startTime}`;
  const end = `${draft.endDate}T${draft.endTime}`;
  if (end <= start) return { error: "End after the start." };
  return {
    input: {
      ...common,
      allDay: false,
      timeZone: draft.timeZone,
      start,
      end,
    },
  };
}
