import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/**
 * Tells mounted views that data they derive from has changed. A write that
 * succeeds publishes the sources it touched; a failed write publishes nothing,
 * so a view never refreshes (or claims freshness) for a change that did not
 * happen. Readers re-run their query when their sources' versions move.
 * There is no polling and no copy of the data: the version is only a signal.
 * See docs/ANALYTICS.md, "Keeping views current".
 */
export type DataSource =
  "habits" | "checkins" | "issues" | "projects" | "milestones" | "calendar";

const ISSUE_WORK: DataSource[] = ["issues", "projects", "milestones"];

/** Every command that writes, and what its change can affect. */
export const MUTATIONS: Record<string, readonly DataSource[]> = {
  // Habits, their routines, and imports or restores of history.
  create_habit: ["habits"],
  rename_habit: ["habits"],
  reorder_habits: ["habits"],
  archive_habit: ["habits"],
  restore_habit: ["habits"],
  delete_habit: ["habits"],
  set_habit_completion: ["habits"],
  import_habits: ["habits"],
  restore_habits: ["habits"],
  undo_habit_restore: ["habits"],
  link_habit_routine: ["habits"],
  unlink_habit_routine: ["habits"],
  // Check-ins.
  save_checkin: ["checkins"],
  delete_checkin: ["checkins"],
  // Issues. Their status feeds objectives and milestones too.
  create_issue: ISSUE_WORK,
  update_issue: ISSUE_WORK,
  change_issue_status: ISSUE_WORK,
  complete_issue: ISSUE_WORK,
  cancel_issue: ISSUE_WORK,
  reopen_issue: ISSUE_WORK,
  set_issue_project: ISSUE_WORK,
  set_issue_milestone: ISSUE_WORK,
  set_issue_due_date: ISSUE_WORK,
  set_issue_recurrence: ISSUE_WORK,
  archive_issue: ISSUE_WORK,
  restore_issue: ISSUE_WORK,
  delete_issue: [...ISSUE_WORK, "calendar"],
  add_issue_relationship: ["issues"],
  remove_issue_relationship: ["issues"],
  import_project_data: [...ISSUE_WORK, "calendar"],
  // Projects, goals, and milestones.
  create_project: ["projects"],
  update_project: ["projects"],
  change_project_status: ["projects"],
  archive_project: ["projects"],
  save_project_mission: ["projects"],
  save_project_objective: ["projects"],
  create_milestone: ["milestones"],
  update_milestone: ["milestones"],
  close_milestone: ["milestones"],
  // Scheduling.
  create_calendar_event: ["calendar"],
  update_calendar_event: ["calendar"],
  duplicate_calendar_event: ["calendar"],
  delete_calendar_event: ["calendar"],
  move_calendar_event: ["calendar"],
  update_event_occurrence: ["calendar"],
  cancel_event_occurrence: ["calendar"],
  restore_event_occurrence: ["calendar"],
  split_event_series: ["calendar"],
  end_event_series: ["calendar"],
  create_issue_work_block: ["calendar"],
  update_issue_work_block: ["calendar"],
  delete_issue_work_block: ["calendar"],
  link_event_project: ["calendar"],
  unlink_event_project: ["calendar"],
  create_calendar: ["calendar"],
  update_calendar: ["calendar"],
  set_calendar_hidden: ["calendar"],
  set_default_calendar: ["calendar"],
  archive_calendar: ["calendar"],
  restore_calendar: ["calendar"],
  import_ics: ["calendar"],
};

const versions = new Map<DataSource, number>();
const listeners = new Set<() => void>();

/** Marks sources as changed and wakes the views reading them. */
export function publish(sources: readonly DataSource[]): void {
  for (const source of sources)
    versions.set(source, (versions.get(source) ?? 0) + 1);
  for (const listener of [...listeners]) listener();
}

/** The sum of the given sources' versions; it moves when any of them does. */
export function versionOf(sources: readonly DataSource[]): number {
  return sources.reduce((sum, source) => sum + (versions.get(source) ?? 0), 0);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders when any of `sources` changes. Put the result in effect deps. */
export function useDataVersion(...sources: DataSource[]): number {
  return useSyncExternalStore(subscribe, () => versionOf(sources));
}

/**
 * The commands' `invoke`. Resolves exactly as Tauri's does; a successful
 * write also publishes its sources, after SQLite has committed.
 */
export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const result = await tauriInvoke<T>(command, args);
  const changed = MUTATIONS[command];
  if (changed) publish(changed);
  return result;
}
