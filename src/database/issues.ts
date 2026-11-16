import { invoke } from "@tauri-apps/api/core";

export const issueStatuses = {
  todo: "To Do",
  in_progress: "In Progress",
  blocked: "Blocked",
  done: "Done",
  canceled: "Canceled",
} as const;

export type IssueStatus = keyof typeof issueStatuses;

/** Mirrors the backend: done and canceled issues are closed. */
export function isClosedStatus(status: IssueStatus): boolean {
  return status === "done" || status === "canceled";
}

export const issuePriorities = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
} as const;

export type IssuePriority = keyof typeof issuePriorities;

/** The editable fields. Status and project have their own commands. */
export interface IssueFields {
  title: string;
  /** Tiptap JSON, stored as text. */
  description: string | null;
  priority: IssuePriority | null;
  startDate: string | null;
  dueDate: string | null;
}

export interface IssueSummary {
  id: string;
  number: number;
  projectId: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  closed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Issue extends IssueSummary {
  description: string;
}

/** The readable ID shown in the interface. */
export function issueKey(issue: Pick<IssueSummary, "number">): string {
  return `ISS-${issue.number}`;
}

// Issue writes run one at a time in the order they were requested, and reads
// wait for earlier writes. A save started while leaving a screen therefore
// lands before the next screen loads its list.
let writes: Promise<unknown> = Promise.resolve();

function write(run: () => Promise<Issue>): Promise<Issue> {
  const result = writes.then(run);
  writes = result.catch(() => undefined);
  return result;
}

function read<T>(run: () => Promise<T>): Promise<T> {
  return writes.then(run);
}

export function listIssues(projectId?: string): Promise<IssueSummary[]> {
  return read(() => invoke("list_issues", { projectId: projectId ?? null }));
}

export function getIssue(id: string): Promise<Issue> {
  return read(() => invoke("get_issue", { id }));
}

export function createIssue(
  input: IssueFields,
  projectId?: string | null,
): Promise<Issue> {
  return write(() =>
    invoke("create_issue", { input, projectId: projectId ?? null }),
  );
}

export function updateIssue(id: string, input: IssueFields): Promise<Issue> {
  return write(() => invoke("update_issue", { id, input }));
}

export function changeIssueStatus(
  id: string,
  status: IssueStatus,
): Promise<Issue> {
  return write(() => invoke("change_issue_status", { id, status }));
}

export function completeIssue(id: string): Promise<Issue> {
  return write(() => invoke("complete_issue", { id }));
}

export function reopenIssue(id: string): Promise<Issue> {
  return write(() => invoke("reopen_issue", { id }));
}

export function setIssueProject(
  id: string,
  projectId: string | null,
): Promise<Issue> {
  return write(() => invoke("set_issue_project", { id, projectId }));
}

export function issueErrorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

export function issueError(error: unknown): string {
  switch (issueErrorCode(error)) {
    case "not_found":
      return "This issue is unavailable in the current workspace.";
    case "invalid_title":
      return "Enter an issue title of 1 to 200 characters.";
    case "invalid_description":
      return "The description could not be saved. It may be too large.";
    case "invalid_priority":
      return "Choose a valid priority.";
    case "invalid_status":
      return "Choose a valid status.";
    case "invalid_date":
      return "Enter valid dates.";
    case "invalid_date_range":
      return "The due date must be on or after the start date.";
    case "invalid_project":
      return "That project is unavailable in the current workspace.";
    default:
      return "Could not access local issue storage. Try again.";
  }
}
