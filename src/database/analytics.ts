import { invoke } from "@tauri-apps/api/core";
import type { CheckinMetric } from "./checkins";
import type { HabitStreaks } from "./habits";

/**
 * Typed wrapper for `get_workspace_analytics` in `src-tauri/src/analytics.rs`.
 * docs/ANALYTICS.md defines every field. Dates are local `YYYY-MM-DD` days,
 * the period is inclusive and at most 366 days, and a rate is null, not 0,
 * when nothing could have counted.
 */
export interface Section<T> {
  /** `not_applicable` when the active filter does not apply to the source. */
  availability: "available" | "not_applicable";
  reason: string | null;
  data: T | null;
}

export interface IssueMetrics {
  created: number;
  completed: number;
  due: number;
  dueCompleted: number;
  duePercent: number | null;
  open: number;
  overdue: number;
}

export interface ProjectMetrics {
  planned: number;
  active: number;
  onHold: number;
  completed: number;
  archived: number;
  targetInPeriod: number;
  targetCompleted: number;
  overdue: number;
}

export interface ObjectiveMetrics {
  objectives: number;
  linkedIssues: number;
  linkedDone: number;
  donePercent: number | null;
}

export interface MilestoneMetrics {
  open: number;
  dueInPeriod: number;
  closedOfDue: number;
  overdue: number;
}

export interface CalendarMetrics {
  events: number;
  allDayEvents: number;
  timedEvents: number;
  scheduledMinutes: number;
  workBlocks: number;
  workBlockMinutes: number;
  /** More items matched than the calendar returns: these are lower bounds. */
  truncated: boolean;
}

export interface HabitMetrics {
  eligible: number;
  completed: number;
  percent: number | null;
  practice: HabitStreaks;
}

export interface MoodMetrics {
  daysRecorded: number;
  daysInPeriod: number;
  mood: CheckinMetric;
  energy: CheckinMetric;
  focus: CheckinMetric;
}

export interface WorkspaceAnalytics {
  period: {
    from: string;
    to: string;
    days: number;
    today: string;
    timeZone: string;
  };
  projectId: string | null;
  issues: Section<IssueMetrics>;
  projects: Section<ProjectMetrics>;
  objectives: Section<ObjectiveMetrics>;
  milestones: Section<MilestoneMetrics>;
  calendar: Section<CalendarMetrics>;
  habits: Section<HabitMetrics>;
  mood: Section<MoodMetrics>;
}

export const getWorkspaceAnalytics = (
  from: string,
  to: string,
  projectId: string | null,
  timeZone: string,
): Promise<WorkspaceAnalytics> =>
  invoke("get_workspace_analytics", { from, to, projectId, timeZone });

export function analyticsError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  switch (code) {
    case "invalid_date":
      return "Use a valid calendar date.";
    case "invalid_range":
      return "Choose a start on or before the end, within 366 days.";
    case "invalid_time_zone":
      return "This device's time zone is not recognized.";
    case "not_found":
      return "That project is unavailable in the current workspace.";
    default:
      return "Could not read local data. Try again.";
  }
}
