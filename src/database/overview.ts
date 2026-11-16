import { invoke } from "@tauri-apps/api/core";
import type { IssueSummary } from "./issues";
import type { Milestone } from "./milestones";
import type { Project } from "./projects";

export interface StatusCounts {
  todo: number;
  inProgress: number;
  blocked: number;
  done: number;
  canceled: number;
}

export interface Activity {
  kind: "created" | "completed" | "updated";
  /** UTC timestamp the event comes from. */
  at: string;
  issueId: string;
  number: number;
  title: string;
}

/**
 * Aggregates over a project's issues and milestones, computed when read.
 * `completion` is done ÷ (total − canceled), or null when that is zero.
 */
export interface ProjectOverview {
  project: Project;
  total: number;
  open: number;
  closed: number;
  statuses: StatusCounts;
  completion: number | null;
  overdueCount: number;
  overdue: IssueSummary[];
  /** Open issues due today through the next 6 days. */
  upcomingCount: number;
  upcoming: IssueSummary[];
  undatedOpen: number;
  milestones: Milestone[];
  activity: Activity[];
}

export function getProjectOverview(
  projectId: string,
  today: string,
): Promise<ProjectOverview> {
  return invoke("get_project_overview", { projectId, today });
}
