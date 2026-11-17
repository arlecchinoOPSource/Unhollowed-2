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
  /** Set for recurring events. */
  repeatFreq: RepeatFreq | null;
  repeatInterval: number | null;
  repeatCount: number | null;
  /** The last date an occurrence may start on, inclusive. */
  repeatUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RepeatFreq = "daily" | "weekly" | "monthly" | "yearly";

/** A repeat rule: every `interval` units, ending after `count` or on `until`. */
export interface RepeatRule {
  freq: RepeatFreq;
  interval: number;
  count: number | null;
  until: string | null;
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
  /** Makes the event recurring; absent or `null` for a single event. */
  repeat?: RepeatRule | null;
}

export type ItemKind = "event" | "deadline" | "workBlock";

/** One entry for a calendar view, from `list_calendar_items`. */
export interface CalendarItem {
  kind: ItemKind;
  /** Unique per item. An occurrence's is `{eventId}:{occurrence}`. */
  id: string;
  /** The stored event an event item comes from. */
  eventId: string | null;
  /** A recurring occurrence's original start, which identifies it. */
  occurrence: string | null;
  recurring: boolean;
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
  /** Timed items: wall-clock times in their own zone. */
  localStart: string | null;
  localEnd: string | null;
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

/** What `search_calendar_items` takes. See docs/CALENDAR.md. */
export interface CalendarSearchInput {
  /** Matched against titles and descriptions. Blank lists upcoming items. */
  text: string;
  timeZone: string;
  /** The viewer's local date, which results are ordered around. */
  today: string;
  /** Absent means every kind, and an empty list means none. */
  kinds?: ItemKind[];
  /** Absent means every visible calendar, and an empty list means none. */
  calendarIds?: string[];
  includeCompleted: boolean;
}

export interface CalendarSearchResults {
  /** Upcoming items soonest first, then earlier items, most recent first. */
  items: CalendarItem[];
  /** How many leading items end on or after `today`. */
  upcoming: number;
  /** More matched than were returned. */
  truncated: boolean;
}

export function searchCalendarItems(
  search: CalendarSearchInput,
): Promise<CalendarSearchResults> {
  return invoke("search_calendar_items", { search });
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

/** Changes one occurrence of a recurring event; it keeps its identity. */
export function updateOccurrence(
  id: string,
  occurrence: string,
  input: EventInput,
): Promise<void> {
  return invoke("update_event_occurrence", { id, occurrence, input });
}

export function cancelOccurrence(
  id: string,
  occurrence: string,
): Promise<void> {
  return invoke("cancel_event_occurrence", { id, occurrence });
}

export function restoreOccurrence(
  id: string,
  occurrence: string,
): Promise<void> {
  return invoke("restore_event_occurrence", { id, occurrence });
}

export interface SplitResult {
  series: CalendarEvent;
  created: CalendarEvent | null;
  keptChanges: number;
  droppedChanges: number;
}

/** Applies `input` to an occurrence and every later one. */
export function splitSeries(
  id: string,
  occurrence: string,
  input: EventInput,
): Promise<SplitResult> {
  return invoke("split_event_series", { id, occurrence, input });
}

/** Deletes an occurrence and every later one. */
export function endSeries(
  id: string,
  occurrence: string,
): Promise<CalendarEvent | null> {
  return invoke("end_event_series", { id, occurrence });
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

/** A stored work session on one issue. Ranges are half-open. */
export interface WorkBlock {
  id: string;
  issueId: string;
  timeZone: string;
  /** Wall-clock `YYYY-MM-DDTHH:MM` in `timeZone`. */
  startLocal: string;
  endLocal: string;
  startAt: string;
  endAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkBlockTiming {
  timeZone: string;
  start: string;
  end: string;
}

export function listWorkBlocks(issueId: string): Promise<WorkBlock[]> {
  return invoke("list_issue_work_blocks", { issueId });
}

export function createWorkBlock(
  issueId: string,
  timing: WorkBlockTiming,
): Promise<WorkBlock> {
  return invoke("create_issue_work_block", { input: { issueId, ...timing } });
}

export function updateWorkBlock(
  id: string,
  input: WorkBlockTiming,
): Promise<WorkBlock> {
  return invoke("update_issue_work_block", { id, input });
}

export function deleteWorkBlock(id: string): Promise<void> {
  return invoke("delete_issue_work_block", { id });
}

/** A document or project an event links to, by its current name. */
export interface LinkedRecord {
  id: string;
  title: string;
  /** Archived records stay linked and can still be opened. */
  archived: boolean;
}

export interface EventLinks {
  documents: LinkedRecord[];
  projects: LinkedRecord[];
}

export type LinkTarget = "document" | "project";

export function getEventLinks(eventId: string): Promise<EventLinks> {
  return invoke("get_event_links", { eventId });
}

export function linkEventRecord(
  eventId: string,
  target: LinkTarget,
  id: string,
): Promise<EventLinks> {
  return invoke(`link_event_${target}`, { eventId, id });
}

export function unlinkEventRecord(
  eventId: string,
  target: LinkTarget,
  id: string,
): Promise<EventLinks> {
  return invoke(`unlink_event_${target}`, { eventId, id });
}
