import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Circle,
  CircleCheck,
  ListTodo,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import {
  completeIssue,
  createIssue,
  issueError,
  issueKey,
  issuePriorities,
  issueStatuses,
  queryIssues,
  reopenIssue,
  type IssueSortField,
  type IssueSummary,
} from "../../database/issues";
import { listLabels, type Label } from "../../database/labels";
import { listProjects, type Project } from "../../database/projects";
import { isTauri } from "../../database/status";
import {
  defaultDirection,
  duePresets,
  hasFilters,
  readFilters,
  resetFilters,
  sortFields,
  states,
  toQuery,
  writeFilters,
  type ListFilters,
  type State,
} from "./filters";
import { LabelBadges, LabelPicker } from "../labels/LabelParts";
import { PriorityBadge, StatusBadge } from "./IssueBadges";
import "./issues.css";

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 250;

interface Results {
  /** The query and request these results answer. */
  key: string;
  issues: IssueSummary[];
  total: number;
  open: number;
  closed: number;
}

/**
 * The issue list used by All Issues and by each project's issue page.
 * Search, filters, and sorting run in SQLite through `query_issues`, so open
 * and closed follow the backend's derived `closed` field. Every filter lives
 * in the URL so it survives opening an issue and coming back.
 */
export function IssueList({ projectId }: { projectId?: string }) {
  const desktop = isTauri();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const [today] = useState(() => new Date());
  const query = toQuery(filters, today, projectId);
  const queryKey = JSON.stringify(query);
  const [results, setResults] = useState<Results | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [loadError, setLoadError] = useState("");
  const [request, setRequest] = useState(0);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // Typed search text waits briefly before it updates the URL and reloads.
  const [typedSearch, setTypedSearch] = useState<string | null>(null);
  const searchTimer = useRef<number>(undefined);
  const titleInput = useRef<HTMLInputElement>(null);
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<number | null>(null);
  // Where the next page starts in the server's ordering. Issues that leave
  // the current state after a quick toggle shift later pages back by one.
  const nextOffset = useRef(0);
  const latestKey = useRef(queryKey);
  useEffect(() => {
    latestKey.current = queryKey;
  });

  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    // Names for links, badges, and chips. The list still works without them.
    listProjects().then(
      (loaded) => {
        if (current) setProjects(loaded);
      },
      () => undefined,
    );
    listLabels().then(
      (loaded) => {
        if (current) setLabels(loaded);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    const key = `${queryKey}#${request}`;
    queryIssues({ ...JSON.parse(queryKey), limit: PAGE_SIZE, offset: 0 }).then(
      (page) => {
        if (!current) return;
        nextOffset.current = page.issues.length;
        setResults({ ...page, key });
      },
      (cause) => {
        if (current) setLoadError(issueError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, queryKey, request]);

  function update(changes: Partial<ListFilters>) {
    setParams(writeFilters({ ...filters, ...changes }), { replace: true });
  }

  function search(value: string) {
    setTypedSearch(value);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      setTypedSearch(null);
      update({ text: value });
    }, SEARCH_DELAY_MS);
  }

  function reset() {
    window.clearTimeout(searchTimer.current);
    setTypedSearch(null);
    setParams(writeFilters(resetFilters(filters)), { replace: true });
  }

  async function loadMore() {
    if (!results || loadingMore) return;
    setLoadingMore(true);
    setActionError("");
    const key = queryKey;
    try {
      const page = await queryIssues({
        ...query,
        limit: PAGE_SIZE,
        offset: nextOffset.current,
      });
      if (key !== latestKey.current) return;
      nextOffset.current += page.issues.length;
      setResults((current) => {
        if (!current) return current;
        const known = new Set(current.issues.map(({ id }) => id));
        return {
          ...page,
          key: current.key,
          issues: [
            ...current.issues,
            ...page.issues.filter(({ id }) => !known.has(id)),
          ],
        };
      });
    } catch (cause) {
      setActionError(issueError(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  const visible =
    results?.issues.filter(
      (issue) =>
        filters.state === "all" ||
        (filters.state === "closed") === issue.closed,
    ) ?? [];
  const counts = results && {
    open: results.open,
    closed: results.closed,
    all: results.open + results.closed,
  };

  // When a completed or reopened issue leaves the current filter, move focus
  // to the row that took its place instead of losing it.
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const target = visible[Math.min(pendingFocus.current, visible.length - 1)];
    pendingFocus.current = null;
    (target ? toggles.current.get(target.id) : titleInput.current)?.focus();
  });

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || results === null) return;
    setActionError("");
    setMessage("");
    const trimmed = title.trim();
    if (!trimmed) {
      setActionError("Enter an issue title.");
      titleInput.current?.focus();
      return;
    }
    setCreating(true);
    try {
      const issue = await createIssue(
        {
          title: trimmed,
          description: null,
          priority: null,
          startDate: null,
          dueDate: null,
        },
        projectId,
      );
      setTitle("");
      setMessage(
        hasFilters(filters)
          ? `Created ${issueKey(issue)}. Reset filters if it is not shown.`
          : `Created ${issueKey(issue)}.`,
      );
      setRequest((value) => value + 1);
    } catch (cause) {
      setActionError(issueError(cause));
    } finally {
      setCreating(false);
    }
  }

  async function toggle(issue: IssueSummary, index: number) {
    if (busy.has(issue.id)) return;
    setBusy((ids) => new Set(ids).add(issue.id));
    setActionError("");
    setMessage("");
    try {
      const updated = issue.closed
        ? await reopenIssue(issue.id)
        : await completeIssue(issue.id);
      const moved = updated.closed !== issue.closed;
      if (moved && filters.state !== "all") {
        pendingFocus.current = index;
        nextOffset.current -= 1;
      }
      setResults((current) => {
        if (!current) return current;
        const shift = moved ? (updated.closed ? 1 : -1) : 0;
        const stillMatches = filters.state === "all" || !moved;
        return {
          key: current.key,
          issues: current.issues.map((item) =>
            item.id === updated.id ? updated : item,
          ),
          open: current.open - shift,
          closed: current.closed + shift,
          total: current.total - (stillMatches ? 0 : 1),
        };
      });
      setMessage(
        `${issueKey(updated)} ${updated.closed ? "completed" : "reopened"}.`,
      );
    } catch (cause) {
      setActionError(issueError(cause));
    } finally {
      setBusy((ids) => {
        const next = new Set(ids);
        next.delete(issue.id);
        return next;
      });
    }
  }

  if (!desktop) {
    return <p>Open the desktop app to manage your local issues.</p>;
  }

  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const from = `${location.pathname}${location.search}`;
  const filtered = hasFilters(filters);
  const active: { label: string; clear: Partial<ListFilters> }[] = [];
  if (filters.text.trim())
    active.push({
      label: `Search: “${filters.text.trim()}”`,
      clear: { text: "" },
    });
  if (filters.status)
    active.push({
      label: `Status: ${issueStatuses[filters.status]}`,
      clear: { status: "" },
    });
  if (filters.priority)
    active.push({
      label: `Priority: ${issuePriorities[filters.priority]}`,
      clear: { priority: "" },
    });
  if (filters.project && !projectId)
    active.push({
      label: `Project: ${
        filters.project === "inbox"
          ? "Inbox"
          : (projectNames.get(filters.project) ?? "Unavailable project")
      }`,
      clear: { project: "" },
    });
  for (const id of filters.labels)
    active.push({
      label: `Label: ${labelsById.get(id)?.name ?? "Unavailable label"}`,
      clear: { labels: filters.labels.filter((other) => other !== id) },
    });
  if (filters.labels.length > 1 && filters.labelMatch === "all")
    active.push({ label: "Match all labels", clear: { labelMatch: "any" } });
  if (filters.due)
    active.push({
      label: `Due: ${duePresets[filters.due]}`,
      clear: { due: "" },
    });
  const empty = counts !== null && counts.all === 0;
  const loading = results !== null && results.key !== `${queryKey}#${request}`;

  return (
    <div className="issues">
      <form className="issue-create" onSubmit={create}>
        <label htmlFor="new-issue-title">New issue</label>
        <div>
          <input
            id="new-issue-title"
            ref={titleInput}
            placeholder="Issue title"
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button
            className="action"
            type="submit"
            aria-disabled={creating || results === null}
          >
            <Plus size={16} aria-hidden="true" />
            {creating ? "Creating…" : "Create issue"}
          </button>
        </div>
      </form>
      {actionError && <p role="alert">{actionError}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>

      <div className="issue-toolbar" role="search" aria-label="Find issues">
        <label className="issue-search">
          Search issues
          <input
            type="search"
            placeholder="Search titles and descriptions"
            maxLength={200}
            value={typedSearch ?? filters.text}
            onChange={(event) => search(event.target.value)}
          />
        </label>
        <label>
          Status
          <select
            value={filters.status}
            onChange={(event) =>
              update({ status: event.target.value as ListFilters["status"] })
            }
          >
            <option value="">Any status</option>
            {Object.entries(issueStatuses).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            value={filters.priority}
            onChange={(event) =>
              update({
                priority: event.target.value as ListFilters["priority"],
              })
            }
          >
            <option value="">Any priority</option>
            {Object.entries(issuePriorities).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {!projectId && (
          <label>
            Project
            <select
              value={filters.project}
              onChange={(event) => update({ project: event.target.value })}
            >
              <option value="">Any project</option>
              <option value="inbox">Inbox (no project)</option>
              {projects
                .filter(
                  (project) =>
                    project.status !== "archived" ||
                    project.id === filters.project,
                )
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Due date
          <select
            value={filters.due}
            onChange={(event) =>
              update({ due: event.target.value as ListFilters["due"] })
            }
          >
            <option value="">Any due date</option>
            {Object.entries(duePresets).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <details className="issue-label-filter">
          <summary>
            Labels
            {filters.labels.length > 0 && ` (${filters.labels.length})`}
          </summary>
          <div>
            <LabelPicker
              legend="Show issues with these labels"
              labels={labels}
              selected={filters.labels}
              allowArchived
              onChange={(ids) => update({ labels: ids })}
            />
            <label className="issue-label-match">
              <input
                type="checkbox"
                checked={filters.labelMatch === "all"}
                onChange={(event) =>
                  update({ labelMatch: event.target.checked ? "all" : "any" })
                }
              />
              Match all selected labels
            </label>
            <Link to="/issues/labels">Manage labels</Link>
          </div>
        </details>
        <div className="issue-sort">
          <label>
            Sort by
            <select
              value={filters.sort}
              onChange={(event) => {
                const sort = event.target.value as IssueSortField;
                update({ sort, direction: defaultDirection(sort) });
              }}
            >
              {Object.entries(sortFields).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="issue-direction"
            aria-label={
              filters.direction === "asc"
                ? "Sorted ascending. Switch to descending"
                : "Sorted descending. Switch to ascending"
            }
            title={filters.direction === "asc" ? "Ascending" : "Descending"}
            onClick={() =>
              update({
                direction: filters.direction === "asc" ? "desc" : "asc",
              })
            }
          >
            {filters.direction === "asc" ? (
              <ArrowUpNarrowWide size={16} aria-hidden="true" />
            ) : (
              <ArrowDownWideNarrow size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {active.length > 0 && (
        <div className="issue-active-filters">
          <span id="active-filters-label">Active filters</span>
          <ul aria-labelledby="active-filters-label">
            {active.map(({ label, clear }) => (
              <li key={label}>
                <button
                  type="button"
                  aria-label={`Remove filter ${label}`}
                  onClick={() => {
                    if ("text" in clear) {
                      window.clearTimeout(searchTimer.current);
                      setTypedSearch(null);
                    }
                    update(clear);
                  }}
                >
                  {label}
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="issue-reset" onClick={reset}>
            Reset filters
          </button>
        </div>
      )}

      <div className="issue-filters" role="group" aria-label="Show issues">
        {(Object.keys(states) as State[]).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={filters.state === value}
            onClick={() => update({ state: value })}
          >
            {states[value]}
            {counts && <span className="issue-count">{counts[value]}</span>}
          </button>
        ))}
      </div>
      {loadError && (
        <div role="alert">
          <p>{loadError}</p>
          <button
            className="action"
            onClick={() => {
              setLoadError("");
              setRequest(request + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {!loadError && results === null && <p>Loading issues…</p>}
      {empty && !filtered && (
        <div className="issues-empty">
          <ListTodo size={24} aria-hidden="true" />
          <h2>
            {projectId ? "No issues in this project yet" : "No issues yet"}
          </h2>
          <p>Create an issue to start tracking your work.</p>
        </div>
      )}
      {empty && filtered && <p>No issues match these filters.</p>}
      {counts && !empty && visible.length === 0 && (
        <p>
          {filters.state === "closed"
            ? "No closed issues match."
            : "No open issues match."}
        </p>
      )}
      {visible.length > 0 && (
        <ul
          className="issue-list"
          aria-label={`${states[filters.state]} issues`}
          aria-busy={loading}
        >
          {visible.map((issue, index) => {
            const projectName =
              issue.projectId && projectNames.get(issue.projectId);
            return (
              <li key={issue.id} className="issue-row">
                <button
                  type="button"
                  className="issue-toggle"
                  ref={(element) => {
                    if (element) toggles.current.set(issue.id, element);
                    else toggles.current.delete(issue.id);
                  }}
                  aria-label={`${issue.closed ? "Reopen" : "Complete"} ${issueKey(issue)}: ${issue.title}`}
                  title={issue.closed ? "Reopen" : "Complete"}
                  aria-disabled={busy.has(issue.id)}
                  onClick={() => void toggle(issue, index)}
                >
                  {issue.closed ? (
                    <CircleCheck size={18} aria-hidden="true" />
                  ) : (
                    <Circle size={18} aria-hidden="true" />
                  )}
                </button>
                <span className="issue-key">{issueKey(issue)}</span>
                <Link
                  className="issue-title"
                  to={`/issues/${issue.id}`}
                  state={{ from }}
                >
                  {issue.title}
                </Link>
                <span className="issue-meta">
                  <StatusBadge status={issue.status} />
                  {issue.priority !== "none" && (
                    <PriorityBadge priority={issue.priority} />
                  )}
                  {!projectId && projectName && (
                    <Link
                      className="issue-project"
                      to={`/projects/${issue.projectId}`}
                    >
                      {projectName}
                    </Link>
                  )}
                  {issue.dueDate && (
                    <span>
                      Due <time dateTime={issue.dueDate}>{issue.dueDate}</time>
                    </span>
                  )}
                  <LabelBadges ids={issue.labelIds} labels={labelsById} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {results && results.total > 0 && (
        <div className="issue-more">
          <p>
            Showing {visible.length} of {results.total}
          </p>
          {visible.length < results.total && (
            <button
              type="button"
              className="action"
              aria-disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more issues"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
