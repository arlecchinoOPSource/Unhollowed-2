import { invoke } from "@tauri-apps/api/core";

/** A stored event. Ranges are half-open: the end is exclusive. */
export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  description: string;
  location: string | null;
  url: string | null;
  allDay: boolean;
  /** All-day events: `YYYY-MM-DD`, end exclusive. */
  startDate: string | null;
  endDate: string | null;
  /** Timed events: the IANA zone and wall-clock `YYYY-MM-DDTHH:MM` there. */
  timeZone: string | null;
  startLocal: string | null;
  endLocal: string | null;
  /** Timed events: the same moments in UTC. */
  startAt: string | null;
  endAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventInput {
  /** The current calendar when editing, or the default when creating. */
  calendarId?: string | null;
  title: string;
  description: string;
  location: string | null;
  url: string | null;
  allDay: boolean;
  startDate?: string | null;
  endDate?: string | null;
  timeZone?: string | null;
  start?: string | null;
  end?: string | null;
}

export type ItemKind = "event" | "deadline" | "workBlock";

/** One entry for a calendar view, from `list_calendar_items`. */
export interface CalendarItem {
  kind: ItemKind;
  id: string;
  title: string;
  calendarId: string | null;
  color: string | null;
  issueId: string | null;
  issueNumber: number | null;
  closed: boolean;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  /** Timed items: wall-clock times in the viewer's zone. */
  start: string | null;
  end: string | null;
  startAt: string | null;
  endAt: string | null;
  /** Timed items: the zone the item was scheduled in. */
  timeZone: string | null;
}

export interface CalendarItems {
  items: CalendarItem[];
  truncated: boolean;
}

/** Items overlapping `[from, to)`, local dates in `timeZone`. */
export function listCalendarItems(
  from: string,
  to: string,
  timeZone: string,
): Promise<CalendarItems> {
  return invoke("list_calendar_items", { range: { from, to, timeZone } });
}

export function getEvent(id: string): Promise<CalendarEvent> {
  return invoke("get_calendar_event", { id });
}

export function createEvent(input: EventInput): Promise<CalendarEvent> {
  return invoke("create_calendar_event", { input });
}

export function updateEvent(
  id: string,
  input: EventInput,
): Promise<CalendarEvent> {
  return invoke("update_calendar_event", { id, input });
}

export function duplicateEvent(id: string): Promise<CalendarEvent> {
  return invoke("duplicate_calendar_event", { id });
}

export function deleteEvent(id: string): Promise<void> {
  return invoke("delete_calendar_event", { id });
}

/** The device's IANA time zone, used to show and enter times. */
export function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** IANA zones the webview knows, with the device zone and UTC included. */
export function timeZones(): string[] {
  const known =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return [...new Set([deviceZone(), "UTC", ...known])].sort((a, b) =>
    a.localeCompare(b),
  );
}
