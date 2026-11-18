import type { ViewFilters } from "../../database/savedViews";
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
  /**
   * Local days, inclusive: only done issues completed on those days. Set by
   * dashboard drilldowns, so the list shows the cohort a chart counted.
   */
  completedFrom: string;
  completedTo: string;
  /** Label IDs. Archived labels can be chosen to find historical issues. */
  labels: string[];
  labelMatch: "any" | "all";
  /** A milestone ID, "none", or "" for any milestone. */
  milestone: string;
  /** "" hides archived issues; "include" shows them too; "only" just them. */
  archived: "" | "include" | "only";
  sort: IssueSortField;
  direction: "asc" | "desc";
}

function pick<T extends string>(
  value: string | null,
  allowed: Record<T, unknown>,
): T | "" {
  return value !== null && Object.hasOwn(allowed, value) ? (value as T) : "";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (value: string | null): value is string =>
  value !== null &&
  DAY.test(value) &&
  value >= "1900-01-01" &&
  localDate(new Date(`${value}T12:00:00`)) === value;

/** Both days of a completed range, or neither: half a range is ignored. */
function completedDays(params: URLSearchParams) {
  const from = params.get("completedFrom");
  const to = params.get("completedTo");
  return realDay(from) && realDay(to) && from <= to
    ? { completedFrom: from, completedTo: to }
    : { completedFrom: "", completedTo: "" };
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
    ...completedDays(params),
    labels: (params.get("labels") ?? "").split(",").filter(Boolean),
    labelMatch: params.get("match") === "all" ? "all" : "any",
    milestone: params.get("milestone") ?? "",
    archived:
      params.get("archived") === "include" || params.get("archived") === "only"
        ? (params.get("archived") as "include" | "only")
        : "",
    sort,
    direction:
      direction === "asc" || direction === "desc"
        ? direction
        : defaultDirection(sort),
  };
}

/**
 * Writes only values that differ from the defaults, keeping URLs short.
 * `view` keeps the open saved view's ID, so editing filters does not lose it.
 */
export function writeFilters(
  filters: ListFilters,
  view?: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (view) params.set("view", view);
  if (filters.state !== "open") params.set("state", filters.state);
  if (filters.text) params.set("q", filters.text);
  if (filters.status) params.set("status", filters.status);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.project) params.set("project", filters.project);
  if (filters.due) params.set("due", filters.due);
  if (filters.completedFrom) {
    params.set("completedFrom", filters.completedFrom);
    params.set("completedTo", filters.completedTo);
  }
  if (filters.labels.length > 0) params.set("labels", filters.labels.join(","));
  if (filters.labelMatch === "all") params.set("match", "all");
  if (filters.milestone) params.set("milestone", filters.milestone);
  if (filters.archived) params.set("archived", filters.archived);
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
    completedFrom: "",
    completedTo: "",
    labels: [],
    labelMatch: "any",
    milestone: "",
    archived: "",
  };
}

export function hasFilters(filters: ListFilters): boolean {
  return Boolean(
    filters.text.trim() ||
    filters.status ||
    filters.priority ||
    filters.project ||
    filters.due ||
    filters.completedFrom ||
    filters.labels.length > 0 ||
    filters.milestone ||
    filters.archived,
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
    milestoneIds:
      filters.milestone && filters.milestone !== "none"
        ? [filters.milestone]
        : [],
    noMilestone: filters.milestone === "none",
    archived: filters.archived || "exclude",
    sort: filters.sort,
    direction: filters.direction,
  };
  if (scope) query.projectIds = [scope];
  else if (filters.project === "inbox") query.inbox = true;
  else if (filters.project) query.projectIds = [filters.project];
  if (filters.completedFrom) {
    // The same instants the progress trend uses for these local days.
    const instant = (day: string, after: number) => {
      const [year, month, date] = day.split("-").map(Number);
      return `${new Date(year, month - 1, date + after).toISOString().slice(0, 19)}Z`;
    };
    query.completedFrom = instant(filters.completedFrom, 0);
    query.completedBefore = instant(filters.completedTo, 1);
  }
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

/**
 * The list filters as stored in a saved view. Version 1 views do not store
 * the archived filter, so saved views always hide archived issues.
 */
export function toViewFilters(filters: ListFilters): ViewFilters {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { archived, completedFrom, completedTo, ...stored } = filters;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return { ...stored, labels: [...filters.labels] };
}

/**
 * The URL for a saved view's filters. Reading stored values through the
 * same parser as the URL drops anything this build does not understand.
 */
export function viewParams(view: ViewFilters, id: string): URLSearchParams {
  const params = new URLSearchParams({
    state: view.state,
    q: view.text,
    status: view.status,
    priority: view.priority,
    project: view.project,
    due: view.due,
    labels: view.labels.join(","),
    match: view.labelMatch,
    milestone: view.milestone,
    sort: view.sort,
    dir: view.direction,
  });
  return writeFilters(readFilters(params), id);
}

/** Whether two filter sets would produce the same URL. */
export function sameFilters(a: ListFilters, b: ListFilters): boolean {
  return writeFilters(a).toString() === writeFilters(b).toString();
}
