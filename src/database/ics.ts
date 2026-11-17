import { invoke } from "./dataChanges";

export interface IcsEntry {
  title: string;
  uid: string;
  recurring: boolean;
  /** Cancelled and changed occurrences applied to the series. */
  exceptions: number;
}

export interface IcsIssue {
  title: string;
  uid: string;
  message: string;
}

/** What an import does. A preview and an import return the same report. */
export interface IcsReport {
  /** The whole file is refused, and why. Nothing changed. */
  fatal: string | null;
  found: number;
  imported: IcsEntry[];
  /** Already present by UID, and left as they are. */
  duplicates: IcsEntry[];
  skipped: IcsIssue[];
  warnings: string[];
  applied: boolean;
}

export interface PickedFile {
  name: string;
  content: string;
}

export interface SavedCalendar {
  path: string;
  events: number;
}

/** The native open dialog. `null` when the user cancels. */
export function pickIcsFile(): Promise<PickedFile | null> {
  return invoke("pick_ics_file");
}

export function previewIcsImport(
  content: string,
  calendarId: string | null,
  timeZone: string,
): Promise<IcsReport> {
  return invoke("preview_ics_import", { content, calendarId, timeZone });
}

export function importIcs(
  content: string,
  calendarId: string | null,
  timeZone: string,
): Promise<IcsReport> {
  return invoke("import_ics", { content, calendarId, timeZone });
}

/** The native save dialog. `null` when the user cancels. */
export function exportCalendarIcs(): Promise<SavedCalendar | null> {
  return invoke("export_calendar_ics");
}
