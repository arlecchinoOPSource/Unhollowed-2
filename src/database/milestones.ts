import { invoke } from "@tauri-apps/api/core";

export interface MilestoneInput {
  title: string;
  description: string | null;
  dueDate: string | null;
}

/**
 * A workspace or project milestone. Counts come from its issues when read.
 * Progress is completed out of open plus completed. Canceled issues are
 * counted separately and do not affect progress.
 */
export interface Milestone extends MilestoneInput {
  id: string;
  /** `null` for a workspace milestone. Fixed after creation. */
  projectId: string | null;
  closed: boolean;
  closedAt: string | null;
  openCount: number;
  completedCount: number;
  canceledCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Completed share of contributing issues, or `null` when there are none. */
export function milestoneProgress(milestone: Milestone): number | null {
  const contributing = milestone.openCount + milestone.completedCount;
  return contributing === 0 ? null : milestone.completedCount / contributing;
}

/** Whether an issue in `projectId` (null for the Inbox) can use the milestone. */
export function fitsIssue(
  milestone: Milestone,
  projectId: string | null,
): boolean {
  return milestone.projectId === null || milestone.projectId === projectId;
}

export function listMilestones(): Promise<Milestone[]> {
  return invoke("list_milestones");
}

export function createMilestone(
  input: MilestoneInput,
  projectId: string | null,
): Promise<Milestone> {
  return invoke("create_milestone", { input, projectId });
}

export function updateMilestone(
  id: string,
  input: MilestoneInput,
): Promise<Milestone> {
  return invoke("update_milestone", { id, input });
}

export function closeMilestone(id: string): Promise<Milestone> {
  return invoke("close_milestone", { id });
}

export function reopenMilestone(id: string): Promise<Milestone> {
  return invoke("reopen_milestone", { id });
}

export function milestoneError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  switch (code) {
    case "not_found":
      return "This milestone is unavailable in the current workspace.";
    case "invalid_title":
      return "Enter a milestone title of 1 to 200 characters.";
    case "invalid_description":
      return "Enter a description of up to 5,000 characters.";
    case "invalid_date":
      return "Enter a valid due date.";
    case "invalid_project":
      return "That project is unavailable in the current workspace.";
    default:
      return "Could not access local milestone storage. Try again.";
  }
}
