import { invoke } from "@tauri-apps/api/core";
import { labelColors, type LabelColor } from "./labels";

/** Calendars share the label palette, so each color is named and readable. */
export const calendarColors = labelColors;
export type CalendarColor = LabelColor;

export interface Calendar {
  id: string;
  name: string;
  description: string | null;
  color: CalendarColor;
  isDefault: boolean;
  /** Hidden calendars keep their events out of calendar views. */
  hidden: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarInput {
  name: string;
  description: string | null;
  color: CalendarColor;
}

/** Lists the workspace's calendars, creating the default the first time. */
export function listCalendars(): Promise<Calendar[]> {
  return invoke("list_calendars");
}

export function createCalendar(input: CalendarInput): Promise<Calendar> {
  return invoke("create_calendar", { input });
}

export function updateCalendar(
  id: string,
  input: CalendarInput,
): Promise<Calendar> {
  return invoke("update_calendar", { id, input });
}

export function setCalendarHidden(
  id: string,
  hidden: boolean,
): Promise<Calendar> {
  return invoke("set_calendar_hidden", { id, hidden });
}

export function setDefaultCalendar(id: string): Promise<Calendar> {
  return invoke("set_default_calendar", { id });
}

/** Archiving the default needs an active `replacement` default. */
export function archiveCalendar(
  id: string,
  replacement?: string,
): Promise<Calendar> {
  return invoke("archive_calendar", { id, replacement: replacement ?? null });
}

export function restoreCalendar(id: string): Promise<Calendar> {
  return invoke("restore_calendar", { id });
}

/** A readable message for a failed calendar or event command. */
export function schedulingError(cause: unknown): string {
  switch ((cause as { code?: string } | null)?.code) {
    case "invalid_name":
      return "Enter a calendar name of up to 80 characters.";
    case "invalid_description":
      return "Shorten the description.";
    case "invalid_color":
      return "Choose one of the calendar colors.";
    case "duplicate_name":
      return "Another calendar already has this name.";
    case "calendar_archived":
      return "Restore this calendar before making it the default.";
    case "replacement_required":
      return "Choose another active calendar to become the default first.";
    case "calendar_not_found":
      return "That calendar is no longer available.";
    case "not_found":
      return "That event is no longer available.";
    case "invalid_title":
      return "Enter a title of up to 200 characters.";
    case "invalid_location":
      return "Shorten the location to 200 characters.";
    case "invalid_url":
      return "Enter a web address starting with http:// or https://.";
    case "invalid_time_zone":
      return "Choose a valid time zone.";
    case "invalid_date":
      return "Enter valid dates.";
    case "invalid_time":
      return "Enter valid times.";
    case "invalid_range":
      return "Make the end later than the start, and keep it under a year.";
    case "database_unavailable":
    case "workspace_read_failed":
      return "Could not open the workspace database.";
    default:
      return "Could not save the change. Try again.";
  }
}
