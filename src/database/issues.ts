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
  /** At most one: a workspace milestone or one for the issue's project. */
  milestoneId: string | null;
  /** Label IDs, including archived labels the issue already had. */
  labelIds: string[];
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

/**
 * Combinable filters shared by issue lists. Board and saved views can store
 * and reuse this shape. Empty lists and missing values mean no restriction.
 */
export interface IssueFilter {
  /** Literal text to find in the title or description. */
  text?: string;
  state?: "open" | "closed" | "all";
  statuses?: IssueStatus[];
  priorities?: IssuePriority[];
  projectIds?: string[];
  /** Also match issues without a project. */
  inbox?: boolean;
  /** Inclusive local dates. A range matches dated issues unless `undated` is include. */
  dueAfter?: string;
  dueBefore?: string;
  undated?: "include" | "exclude" | "only";
  /** Issues with these labels. Archived labels still match. */
  labelIds?: string[];
  /** `any` (default) matches one of the labels, `all` every label. */
  labelMatch?: "any" | "all";
  milestoneIds?: string[];
  /** Also match issues without a milestone. */
  noMilestone?: boolean;
}

export type IssueSortField =
  "updated" | "created" | "priority" | "title" | "due";

export interface IssueQuery extends IssueFilter {
  sort?: IssueSortField;
  direction?: "asc" | "desc";
  /** 1 to 200, default 100. */
  limit?: number;
  offset?: number;
}

export interface IssuePage {
  issues: IssueSummary[];
  /** Matches for the whole query, across pages. */
  total: number;
  /** Matches for the query without its state. */
  open: number;
  closed: number;
}

export function queryIssues(query: IssueQuery): Promise<IssuePage> {
  return read(() => invoke("query_issues", { query }));
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

/** Sets or clears the issue's milestone. */
export function setIssueMilestone(
  id: string,
  milestoneId: string | null,
): Promise<Issue> {
  return write(() => invoke("set_issue_milestone", { id, milestoneId }));
}

/** Replaces the issue's labels. Archived labels can stay but not be added. */
export function setIssueLabels(id: string, labelIds: string[]): Promise<Issue> {
  return write(() => invoke("set_issue_labels", { id, labelIds }));
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
    case "invalid_label":
      return "That label is unavailable in the current workspace.";
    case "label_archived":
      return "Archived labels cannot be added. Restore the label first.";
    case "invalid_milestone":
      return "That milestone does not apply to this issue's project.";
    case "milestone_closed":
      return "Closed milestones cannot gain issues. Reopen the milestone first.";
    case "invalid_filter":
      return "These filters are not supported. Reset them and try again.";
    default:
      return "Could not access local issue storage. Try again.";
  }
}
