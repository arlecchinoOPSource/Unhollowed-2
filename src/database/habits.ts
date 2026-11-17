import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers for the habit commands in `src-tauri/src/habits.rs`. Each
 * resolves only after SQLite has committed. Dates are local `YYYY-MM-DD`
 * days. See docs/HABITS.md.
 */
export interface Habit {
  id: string;
  name: string;
  position: number;
  startDate: string;
  /** The last eligible day, inclusive. Null while the habit is active. */
  archivedOn: string | null;
  source: "ember" | null;
  sourceId: string | null;
  /** Raised by every write to the habit or its completions. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface HabitCompletion {
  habitId: string;
  date: string;
}

export interface HabitMonth {
  /** Today on the device clock, as Rust saw it. */
  today: string;
  /** Habits eligible on at least one day of the month, in saved order. */
  habits: Habit[];
  completions: HabitCompletion[];
}

export interface HabitDeletionImpact {
  name: string;
  archived: boolean;
  completions: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Pass back to `deleteHabit`; a changed habit must be reviewed again. */
  revision: number;
}

/** One habit an Ember import adds, in the order it will have. */
export interface ImportedHabit {
  name: string;
  startDate: string;
  archivedOn: string | null;
  completions: number;
}

/** What an import does. A preview and an import return the same report. */
export interface HabitImportReport {
  /** The whole file is refused, and why. Nothing changed. */
  fatal: string | null;
  /** Habits the file collides with, when that is the reason. */
  conflicts: string[];
  habits: ImportedHabit[];
  completions: number;
  /** Pass back to `importHabits`; it changes when the file or habits change. */
  token: string;
  applied: boolean;
}

export interface PickedBackup {
  name: string;
  content: string;
}

/** The native open dialog. `null` when the user cancels. */
export const pickHabitBackup = (): Promise<PickedBackup | null> =>
  invoke("pick_habit_backup");

export const previewHabitImport = (
  content: string,
): Promise<HabitImportReport> => invoke("preview_habit_import", { content });

export const importHabits = (
  content: string,
  token: string,
): Promise<HabitImportReport> => invoke("import_habits", { content, token });

export interface SavedHabits {
  path: string;
  habits: number;
  completions: number;
}

/** What a restore does, or did. A preview and a restore return the same. */
export interface HabitRestoreReport {
  /** The restore is refused, and why. Nothing changed. */
  fatal: string | null;
  habits: number;
  archived: number;
  completions: number;
  /** What the restore replaces. */
  currentHabits: number;
  currentCompletions: number;
  /** Pass back to `restoreHabits`; it changes when the file or habits do. */
  token: string;
  applied: boolean;
  /** The private copy of the replaced habits, by name. Pass to undo. */
  recovery: string | null;
}

/** The native save dialogs. `null` when the user cancels. */
export const exportHabitBackup = (): Promise<SavedHabits | null> =>
  invoke("export_habit_backup");

export const exportHabitHistory = (
  format: "csv" | "json",
): Promise<SavedHabits | null> => invoke("export_habit_history", { format });

export const pickHabitRestore = (): Promise<PickedBackup | null> =>
  invoke("pick_habit_restore");

export const previewHabitRestore = (
  content: string,
): Promise<HabitRestoreReport> => invoke("preview_habit_restore", { content });

export const restoreHabits = (
  content: string,
  token: string,
): Promise<HabitRestoreReport> => invoke("restore_habits", { content, token });

export const undoHabitRestore = (name: string): Promise<HabitRestoreReport> =>
  invoke("undo_habit_restore", { name });

export const listHabits = (): Promise<Habit[]> => invoke("list_habits");

export const createHabit = (
  name: string,
  startDate: string | null = null,
): Promise<Habit> => invoke("create_habit", { name, startDate });

export const renameHabit = (id: string, name: string): Promise<Habit> =>
  invoke("rename_habit", { id, name });

/** Every habit's ID, archived included, in the new order. */
export const reorderHabits = (ids: string[]): Promise<Habit[]> =>
  invoke("reorder_habits", { ids });

export const archiveHabit = (id: string): Promise<Habit> =>
  invoke("archive_habit", { id });

export const restoreHabit = (id: string): Promise<Habit> =>
  invoke("restore_habit", { id });

export const getHabitDeletionImpact = (
  id: string,
): Promise<HabitDeletionImpact> => invoke("get_habit_deletion_impact", { id });

export const deleteHabit = (id: string, revision: number): Promise<void> =>
  invoke("delete_habit", { id, revision });

export const getHabitMonth = (
  year: number,
  month: number,
): Promise<HabitMonth> => invoke("get_habit_month", { year, month });

export const listHabitHistory = (id: string): Promise<string[]> =>
  invoke("list_habit_history", { id });

/** Saves the wanted state and resolves with it. Repeating it is safe. */
export const setHabitCompletion = (
  id: string,
  date: string,
  done: boolean,
): Promise<boolean> => invoke("set_habit_completion", { id, date, done });

export function habitError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  switch (code) {
    case "not_found":
      return "This habit is unavailable in the current workspace.";
    case "invalid_name":
      return "Enter a habit name of 1 to 60 characters.";
    case "invalid_date":
      return "Use a valid calendar date.";
    case "invalid_month":
      return "Choose a valid month.";
    case "duplicate_name":
      return "An active habit already has this name. Choose a different name.";
    case "invalid_order":
      return "The habit list changed. Reload and try again.";
    case "future_date":
      return "Future days cannot be checked yet.";
    case "before_start":
      return "This habit had not started on that day.";
    case "inactive":
      return "This habit was archived before that day.";
    case "not_archived":
      return "Archive the habit before deleting it.";
    case "changed":
      return "This habit changed since you reviewed it. Review the deletion again.";
    case "file_failed":
      return "Could not read that file.";
    case "file_too_large":
      return "That file is larger than 32 MiB.";
    case "copy_failed":
      return "A private copy of your current habits could not be saved, so nothing was replaced.";
    case "invalid_format":
      return "Choose CSV or JSON.";
    default:
      return "Could not save to local habit storage. Try again.";
  }
}
