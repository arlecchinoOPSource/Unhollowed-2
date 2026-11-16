import {
  issuePriorities,
  issueStatuses,
  type IssuePriority,
  type IssueQuery,
  type IssueSortField,
  type IssueStatus,
} from "../../database/issues";

export const states = { open: "Open", closed: "Closed", all: "All" } as const;
export type State = keyof typeof states;

export const duePresets = {
  overdue: "Overdue",
  today: "Due today",
  week: "Due in the next 7 days",
  dated: "Has a due date",
  none: "No due date",
} as const;
export type DuePreset = keyof typeof duePresets;

export const sortFields: Record<IssueSortField, string> = {
  updated: "Last updated",
  created: "Created",
  priority: "Priority",
  title: "Title",
  due: "Due date",
};

/** Title and due date read naturally A→Z and soonest first. */
export function defaultDirection(sort: IssueSortField): "asc" | "desc" {
  return sort === "title" || sort === "due" ? "asc" : "desc";
}

/** The list's filters as stored in the URL. Empty strings mean "any". */
export interface ListFilters {
  state: State;
  text: string;
  status: IssueStatus | "";
  priority: IssuePriority | "";
  /** A project ID, "inbox", or "" for any project. */
  project: string;
  due: DuePreset | "";
  /** Label IDs. Archived labels can be chosen to find historical issues. */
  labels: string[];
  labelMatch: "any" | "all";
  sort: IssueSortField;
  direction: "asc" | "desc";
}

function pick<T extends string>(
  value: string | null,
  allowed: Record<T, unknown>,
): T | "" {
  return value !== null && Object.hasOwn(allowed, value) ? (value as T) : "";
}

export function readFilters(params: URLSearchParams): ListFilters {
  const sort = pick(params.get("sort"), sortFields) || "updated";
  const direction = params.get("dir");
  return {
    state: pick(params.get("state"), states) || "open",
    text: params.get("q") ?? "",
    status: pick(params.get("status"), issueStatuses),
    priority: pick(params.get("priority"), issuePriorities),
    project: params.get("project") ?? "",
    due: pick(params.get("due"), duePresets),
    labels: (params.get("labels") ?? "").split(",").filter(Boolean),
    labelMatch: params.get("match") === "all" ? "all" : "any",
    sort,
    direction:
      direction === "asc" || direction === "desc"
        ? direction
        : defaultDirection(sort),
  };
}

/** Writes only values that differ from the defaults, keeping URLs short. */
export function writeFilters(filters: ListFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.state !== "open") params.set("state", filters.state);
  if (filters.text) params.set("q", filters.text);
  if (filters.status) params.set("status", filters.status);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.project) params.set("project", filters.project);
  if (filters.due) params.set("due", filters.due);
  if (filters.labels.length > 0) params.set("labels", filters.labels.join(","));
  if (filters.labelMatch === "all") params.set("match", "all");
  if (filters.sort !== "updated") params.set("sort", filters.sort);
  if (filters.direction !== defaultDirection(filters.sort))
    params.set("dir", filters.direction);
  return params;
}

/** Clears the filters that narrow results, keeping the state tab and sort. */
export function resetFilters(filters: ListFilters): ListFilters {
  return {
    ...filters,
    text: "",
    status: "",
    priority: "",
    project: "",
    due: "",
    labels: [],
    labelMatch: "any",
  };
}

export function hasFilters(filters: ListFilters): boolean {
  return Boolean(
    filters.text.trim() ||
    filters.status ||
    filters.priority ||
    filters.project ||
    filters.due ||
    filters.labels.length > 0,
  );
}

/** A local calendar date in YYYY-MM-DD form, `days` after `from`. */
export function localDate(from: Date, days = 0): string {
  const date = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate() + days,
  );
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Builds the backend query. Date presets resolve against the local `today`,
 * so a saved link keeps meaning "overdue" on later days.
 */
export function toQuery(
  filters: ListFilters,
  today: Date,
  scope?: string,
): IssueQuery {
  const query: IssueQuery = {
    text: filters.text.trim() || undefined,
    state: filters.state,
    statuses: filters.status ? [filters.status] : [],
    priorities: filters.priority ? [filters.priority] : [],
    labelIds: filters.labels,
    labelMatch: filters.labelMatch,
    sort: filters.sort,
    direction: filters.direction,
  };
  if (scope) query.projectIds = [scope];
  else if (filters.project === "inbox") query.inbox = true;
  else if (filters.project) query.projectIds = [filters.project];
  switch (filters.due) {
    case "overdue":
      query.dueBefore = localDate(today, -1);
      query.undated = "exclude";
      break;
    case "today":
      query.dueAfter = query.dueBefore = localDate(today);
      query.undated = "exclude";
      break;
    case "week":
      query.dueAfter = localDate(today);
      query.dueBefore = localDate(today, 6);
      query.undated = "exclude";
      break;
    case "dated":
      query.undated = "exclude";
      break;
    case "none":
      query.undated = "only";
      break;
  }
  return query;
}
