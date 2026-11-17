import type {
  CalendarEvent,
  EventInput,
  RepeatFreq,
} from "../../database/events";
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
  /** `""` when the event does not repeat. */
  repeatFreq: RepeatFreq | "";
  repeatInterval: string;
  repeatEnd: "never" | "count" | "until";
  repeatCount: string;
  repeatUntil: string;
}

const noRepeat = {
  repeatFreq: "" as const,
  repeatInterval: "1",
  repeatEnd: "never" as const,
  repeatCount: "10",
  repeatUntil: "",
};

/** One occurrence's span: wall-clock times in the event's zone, or dates
 * with an exclusive end. */
export interface OccurrenceSpan {
  start: string;
  end: string;
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
    ...noRepeat,
  };
}

/** A draft of an event, or of one occurrence when `span` is given. */
export function draftFromEvent(
  event: CalendarEvent,
  fallbackZone: string,
  span?: OccurrenceSpan,
): Draft {
  const start =
    span?.start ?? (event.allDay ? event.startDate! : event.startLocal!);
  const end = span?.end ?? (event.allDay ? event.endDate! : event.endLocal!);
  const [startDate, startTime] = start.split("T");
  const [endDate, endTime] = end.split("T");
  return {
    title: event.title,
    allDay: event.allDay,
    startDate,
    startTime: event.allDay ? "09:00" : startTime,
    endDate: event.allDay ? addDays(endDate, -1) : endDate,
    endTime: event.allDay ? "10:00" : endTime,
    timeZone: event.timeZone ?? fallbackZone,
    calendarId: event.calendarId,
    location: event.location ?? "",
    url: event.url ?? "",
    description: event.description,
    ...(event.repeatFreq
      ? {
          repeatFreq: event.repeatFreq,
          repeatInterval: String(event.repeatInterval ?? 1),
          repeatEnd: event.repeatCount
            ? ("count" as const)
            : event.repeatUntil
              ? ("until" as const)
              : ("never" as const),
          repeatCount: String(event.repeatCount ?? 10),
          repeatUntil: event.repeatUntil ?? "",
        }
      : noRepeat),
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
  let repeat: EventInput["repeat"] = null;
  if (draft.repeatFreq) {
    const interval = Number(draft.repeatInterval);
    const count = Number(draft.repeatCount);
    if (!Number.isInteger(interval) || interval < 1 || interval > 99)
      return { error: "Repeat every 1 to 99." };
    if (
      draft.repeatEnd === "count" &&
      (!Number.isInteger(count) || count < 1 || count > 999)
    )
      return { error: "Repeat 1 to 999 times." };
    if (
      draft.repeatEnd === "until" &&
      (!DATE.test(draft.repeatUntil) || draft.repeatUntil < draft.startDate)
    )
      return { error: "End the repeat on or after the start date." };
    repeat = {
      freq: draft.repeatFreq,
      interval,
      count: draft.repeatEnd === "count" ? count : null,
      until: draft.repeatEnd === "until" ? draft.repeatUntil : null,
    };
  }
  const common = {
    calendarId: draft.calendarId || null,
    title,
    description: draft.description,
    location: draft.location.trim() || null,
    url: draft.url.trim() || null,
    repeat,
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

/** Minutes since 1970 of a wall-clock `YYYY-MM-DDTHH:MM`, ignoring zones. */
function civil(value: string): number {
  const [date, time = "00:00"] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) / 60_000;
}

function fromCivil(minutes: number, withTime: boolean): string {
  const iso = new Date(minutes * 60_000).toISOString();
  return withTime ? iso.slice(0, 16) : iso.slice(0, 10);
}

/**
 * Turns an edit made on one occurrence into an edit of the whole series:
 * the series' first occurrence moves by the same wall-clock amount as this
 * occurrence moved, and takes its new length. `occurrence` is the edited
 * occurrence's original start.
 */
export function seriesInput(
  event: CalendarEvent,
  occurrence: string,
  input: EventInput,
): EventInput {
  if (input.allDay) {
    const shift = civil(input.startDate!) - civil(occurrence);
    const length = civil(input.endDate!) - civil(input.startDate!);
    const base = event.allDay
      ? event.startDate!
      : event.startLocal!.slice(0, 10);
    const start = civil(base) + shift;
    return {
      ...input,
      startDate: fromCivil(start, false),
      endDate: fromCivil(start + length, false),
    };
  }
  const shift = civil(input.start!) - civil(occurrence);
  const length = civil(input.end!) - civil(input.start!);
  const base = event.allDay ? `${event.startDate!}T00:00` : event.startLocal!;
  const start = civil(base) + shift;
  return {
    ...input,
    start: fromCivil(start, true),
    end: fromCivil(start + length, true),
  };
}
