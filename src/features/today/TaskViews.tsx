import { CalendarCheck, Circle, CircleCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, useLocation, useSearchParams } from "react-router";
import {
  completeIssue,
  issueError,
  issueKey,
  queryIssues,
  reopenIssue,
  setIssueDueDate,
  type IssueQuery,
  type IssueSummary,
} from "../../database/issues";
import { isTauri } from "../../database/status";
import { PriorityBadge, RepeatMark } from "../issues/IssueBadges";
import { useIssueReferences } from "../issues/useIssueReferences";
import { addDays, dayLabel } from "./dates";
import { TodaySchedule } from "./TodaySchedule";
import { useLocalToday } from "./useLocalToday";
import "../issues/issues.css";
import "./today.css";

const PAGE_SIZE = 100;

type Mode = "today" | "upcoming";

interface Results {
  /** The view, day, and request these results answer. */
  key: string;
  issues: IssueSummary[];
  total: number;
}

/**
 * The shared query for each view. Both list only open issues with a due
 * date, earliest first. Today is everything due on or before the local
 * date, so overdue issues stay visible. Upcoming starts tomorrow.
 */
function viewQuery(mode: Mode, today: string): IssueQuery {
  return {
    state: "open",
    undated: "exclude",
    sort: "due",
    direction: "asc",
    ...(mode === "today"
      ? { dueBefore: today }
      : { dueAfter: addDays(today, 1) }),
  };
}

/** "today", "tomorrow", or "on Friday, Nov 20" for messages. */
function duePhrase(date: string, today: string): string {
  const label = dayLabel(date, today);
  return label === "Today" || label === "Tomorrow"
    ? label.toLowerCase()
    : `on ${label}`;
}

/** Whether a due date belongs in the view on `today`. */
function inView(mode: Mode, due: string | null, today: string): boolean {
  if (!due) return false;
  return mode === "today" ? due <= today : due > today;
}

export function TodayPage() {
  return <TaskViews mode="today" />;
}

export function UpcomingPage() {
  return <TaskViews mode="upcoming" />;
}

function TaskViews({ mode }: { mode: Mode }) {
  const desktop = isTauri();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const byProject = params.get("group") === "project";
  const today = useLocalToday();
  const { projects } = useIssueReferences(desktop);
  const [results, setResults] = useState<Results | null>(null);
  const [undated, setUndated] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [request, setRequest] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const key = `${mode}#${today}#${request}`;
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const nextOffset = useRef(0);
  // Rescheduling can move a loaded row across the pagination boundary.
  const restartPagination = useRef(false);
  const latestKey = useRef(key);
  useEffect(() => {
    latestKey.current = key;
  }, [key]);

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    const [view, day] = key.split("#");
    Promise.all([
      queryIssues({
        ...viewQuery(view as Mode, day),
        limit: PAGE_SIZE,
        offset: 0,
      }),
      queryIssues({ state: "open", undated: "only", limit: 1 }),
    ]).then(
      ([page, withoutDate]) => {
        if (!current) return;
        nextOffset.current = page.issues.length;
        restartPagination.current = false;
        setResults({ key, issues: page.issues, total: page.total });
        setUndated(withoutDate.total);
      },
      (cause) => {
        if (current) setLoadError(issueError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, key]);

  // After an issue leaves the view, focus the row that took its place.
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const rows = results?.issues ?? [];
    const target = rows[Math.min(pendingFocus.current, rows.length - 1)];
    pendingFocus.current = null;
    (target ? toggles.current.get(target.id) : heading.current)?.focus();
  });

  function replace(updated: IssueSummary) {
    setResults(
      (current) =>
        current && {
          ...current,
          issues: current.issues.map((item) =>
            item.id === updated.id ? updated : item,
          ),
        },
    );
  }

  // Completed issues stay in place, marked done, until the view next loads,
  // so the list does not shift under the pointer or lose focus.
  async function toggle(issue: IssueSummary) {
    if (busy.size || loadingMore || results?.key !== key) return;
    setBusy((ids) => new Set(ids).add(issue.id));
    setError("");
    setMessage("");
    try {
      const updated = issue.closed
        ? await reopenIssue(issue.id)
        : await completeIssue(issue.id);
      replace(updated);
      if (latestKey.current === key) {
        restartPagination.current = true;
        setResults((current) =>
          current?.key === key
            ? { ...current, total: current.total + (updated.closed ? -1 : 1) }
            : current,
        );
      }
      setMessage(
        `${issueKey(updated)} ${updated.closed ? "completed" : "reopened"}.`,
      );
    } catch (cause) {
      setError(issueError(cause));
    } finally {
      setBusy((ids) => {
        const next = new Set(ids);
        next.delete(issue.id);
        return next;
      });
    }
  }

  async function reschedule(issue: IssueSummary, dueDate: string | null) {
    if (
      dueDate === issue.dueDate ||
      loadingMore ||
      busy.size ||
      results?.key !== key
    )
      return;
    setBusy((ids) => new Set(ids).add(issue.id));
    setError("");
    setMessage("");
    const index = results?.issues.findIndex(({ id }) => id === issue.id) ?? 0;
    const leaves = !inView(mode, dueDate, today);
    // Show the change at once and put it back if it is rejected.
    setResults(
      (current) =>
        current && {
          ...current,
          total: current.total - (leaves ? 1 : 0),
          issues: leaves
            ? current.issues.filter(({ id }) => id !== issue.id)
            : current.issues
                .map((item) =>
                  item.id === issue.id ? { ...item, dueDate } : item,
                )
                .sort(
                  (a, b) =>
                    (a.dueDate ?? "").localeCompare(b.dueDate ?? "") ||
                    a.number - b.number,
                ),
        },
    );
    if (leaves) {
      pendingFocus.current = index;
    }
    try {
      const updated = await setIssueDueDate(issue.id, dueDate);
      if (!leaves) replace(updated);
      if (latestKey.current === key) restartPagination.current = true;
      const moved = leaves
        ? mode === "today"
          ? " and moved to Upcoming"
          : " and moved to Today"
        : "";
      setMessage(
        dueDate
          ? `${issueKey(updated)} is now due ${duePhrase(dueDate, today)}${moved}.`
          : `${issueKey(updated)} no longer has a due date.`,
      );
      if (!dueDate) setUndated((count) => (count ?? 0) + 1);
    } catch (cause) {
      if (latestKey.current !== key) return;
      setResults(
        (current) =>
          current && {
            ...current,
            total: current.total + (leaves ? 1 : 0),
            issues: [
              ...current.issues.filter(({ id }) => id !== issue.id),
              issue,
            ].sort(
              (a, b) =>
                (a.dueDate ?? "").localeCompare(b.dueDate ?? "") ||
                a.number - b.number,
            ),
          },
      );
      setError(`Could not reschedule ${issueKey(issue)}. ${issueError(cause)}`);
    } finally {
      setBusy((ids) => {
        const next = new Set(ids);
        next.delete(issue.id);
        return next;
      });
    }
  }

  async function loadMore() {
    if (!results || results.key !== key || loadingMore || busy.size) return;
    setLoadingMore(true);
    const loadingKey = results.key;
    let offset = restartPagination.current ? 0 : nextOffset.current;
    const known = new Set(results.issues.map(({ id }) => id));
    try {
      while (true) {
        const page = await queryIssues({
          ...viewQuery(mode, today),
          limit: PAGE_SIZE,
          offset,
        });
        if (latestKey.current !== loadingKey) return;
        offset += page.issues.length;
        const additions = page.issues.filter(({ id }) => !known.has(id));
        if (
          additions.length === 0 &&
          page.issues.length > 0 &&
          offset < page.total
        )
          continue;
        nextOffset.current = offset;
        restartPagination.current = false;
        setResults((current) =>
          current?.key === loadingKey
            ? {
                ...current,
                total: page.total,
                issues: [...current.issues, ...additions],
              }
            : current,
        );
        break;
      }
    } catch (cause) {
      setError(issueError(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  const title = mode === "today" ? "Today" : "Upcoming";
  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const issues = results?.issues ?? [];
  const groups = new Map<string, IssueSummary[]>();
  for (const issue of issues) {
    const group = byProject
      ? (issue.projectId && projectNames.get(issue.projectId)) || "Inbox"
      : mode === "today"
        ? issue.dueDate! < today
          ? "Overdue"
          : "Today"
        : dayLabel(issue.dueDate!, today);
    groups.set(group, [...(groups.get(group) ?? []), issue]);
  }
  // Inbox last when grouping by project, so projects lead.
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    byProject
      ? Number(a === "Inbox") - Number(b === "Inbox") || a.localeCompare(b)
      : 0,
  );
  const search = byProject ? "?group=project" : "";
  const from = `${location.pathname}${location.search}`;
  const loading = results !== null && results.key !== key;

  return (
    <section className="task-views">
      <div className="issue-page-top">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {title}
          </h1>
        </div>
        <label className="task-group-toggle">
          <input
            type="checkbox"
            checked={byProject}
            onChange={(event) =>
              setParams(event.target.checked ? { group: "project" } : {}, {
                replace: true,
              })
            }
          />
          Group by project
        </label>
      </div>
      <nav className="task-tabs" aria-label="Task views">
        <NavLink to={`/today${search}`} end>
          Today
        </NavLink>
        <NavLink to={`/today/upcoming${search}`}>Upcoming</NavLink>
      </nav>
      {!desktop && <p>Open the desktop app to see your tasks.</p>}
      {desktop && mode === "today" && <TodaySchedule today={today} />}
      {error && <p role="alert">{error}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>
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
      {desktop && !loadError && results === null && <p>Loading {title}…</p>}
      {results && issues.length === 0 && (
        <div className="issues-empty">
          <CalendarCheck size={24} aria-hidden="true" />
          <h2>
            {mode === "today" ? "Nothing due today" : "Nothing scheduled ahead"}
          </h2>
          <p>
            {mode === "today"
              ? "Open issues due today or earlier appear here."
              : "Open issues with a future due date appear here."}
          </p>
        </div>
      )}
      <div aria-busy={loading}>
        {ordered.map(([group, items]) => {
          const id = `task-group-${group.replace(/\W+/g, "-")}`;
          return (
            <section key={group} className="task-group" aria-labelledby={id}>
              <h2 id={id}>
                {group}{" "}
                <span className="issue-count">
                  {items.length}
                  <span className="visually-hidden"> issues</span>
                </span>
              </h2>
              <ul className="issue-list" aria-labelledby={id}>
                {items.map((issue) => (
                  <TaskRow
                    key={issue.id}
                    issue={issue}
                    today={today}
                    showDate={byProject || mode === "today"}
                    projectName={
                      byProject
                        ? null
                        : (issue.projectId &&
                            projectNames.get(issue.projectId)) ||
                          null
                    }
                    from={from}
                    busy={busy.size > 0 || loadingMore || loading}
                    toggleRef={(element) => {
                      if (element) toggles.current.set(issue.id, element);
                      else toggles.current.delete(issue.id);
                    }}
                    onToggle={() => void toggle(issue)}
                    onReschedule={(date) => void reschedule(issue, date)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {results &&
        issues.filter((issue) => !issue.closed).length < results.total && (
          <div className="issue-more">
            <p>
              Showing {issues.filter((issue) => !issue.closed).length} of{" "}
              {results.total}
            </p>
            <button
              type="button"
              className="action"
              aria-disabled={loadingMore || loading || busy.size > 0}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      {undated !== null && undated > 0 && (
        <p className="task-undated">
          {undated === 1
            ? "1 open issue has no due date and is not shown here. "
            : `${undated} open issues have no due date and are not shown here. `}
          <Link to="/issues?due=none">Review issues without a due date</Link>
        </p>
      )}
    </section>
  );
}

function TaskRow({
  issue,
  today,
  showDate,
  projectName,
  from,
  busy,
  toggleRef,
  onToggle,
  onReschedule,
}: {
  issue: IssueSummary;
  today: string;
  showDate: boolean;
  projectName: string | null;
  from: string;
  busy: boolean;
  toggleRef: (element: HTMLButtonElement | null) => void;
  onToggle: () => void;
  onReschedule: (date: string | null) => void;
}) {
  // Dates commit on Enter or when leaving the field, never while typing, so
  // a half-typed year cannot reschedule the issue. Escape discards the edit.
  const [draft, setDraft] = useState<string | null>(null);
  const due = issue.dueDate!;
  const overdue = !issue.closed && due < today;

  function commit(event?: FormEvent) {
    event?.preventDefault();
    if (draft === null) return;
    const value = draft || null;
    setDraft(null);
    if (value !== issue.dueDate) onReschedule(value);
  }

  return (
    <li className={`issue-row task-row${issue.closed ? " task-done" : ""}`}>
      <button
        type="button"
        className="issue-toggle"
        ref={toggleRef}
        aria-label={`${issue.closed ? "Reopen" : "Complete"} ${issueKey(issue)}: ${issue.title}`}
        title={issue.closed ? "Reopen" : "Complete"}
        aria-disabled={busy}
        onClick={onToggle}
      >
        {issue.closed ? (
          <CircleCheck size={18} aria-hidden="true" />
        ) : (
          <Circle size={18} aria-hidden="true" />
        )}
      </button>
      <span className="issue-key">{issueKey(issue)}</span>
      <Link className="issue-title" to={`/issues/${issue.id}`} state={{ from }}>
        {issue.title}
      </Link>
      <span className="issue-meta">
        {issue.closed && <span className="task-state">Completed</span>}
        {issue.priority !== "none" && (
          <PriorityBadge priority={issue.priority} />
        )}
        {projectName && <span>{projectName}</span>}
        {issue.recurring && <RepeatMark />}
        {showDate && (
          <span className={overdue ? "task-overdue" : undefined}>
            {overdue ? "Overdue, due " : "Due "}
            <time dateTime={due}>{dayLabel(due, today)}</time>
          </span>
        )}
      </span>
      {!issue.closed && (
        <form className="task-reschedule" onSubmit={commit}>
          {due <= today && (
            <button
              type="button"
              disabled={busy}
              aria-label={`Move ${issueKey(issue)} to tomorrow`}
              onClick={() => onReschedule(addDays(today, 1))}
            >
              Tomorrow
            </button>
          )}
          <label>
            <span className="visually-hidden">
              Due date for {issueKey(issue)}
            </span>
            <input
              type="date"
              readOnly={busy}
              value={draft ?? due}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => commit()}
              onKeyDown={(event) => {
                // Date fields do not submit forms on Enter in every browser.
                if (event.key === "Enter") commit(event);
                if (event.key === "Escape" && draft !== null) {
                  event.preventDefault();
                  setDraft(null);
                }
              }}
            />
          </label>
        </form>
      )}
    </li>
  );
}
