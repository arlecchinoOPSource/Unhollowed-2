import { Circle, CircleCheck, Flag, ListTodo, Plus } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import {
  completeIssue,
  createIssue,
  issueError,
  issueKey,
  queryIssues,
  reopenIssue,
  type IssueSummary,
} from "../../database/issues";
import { isTauri } from "../../database/status";
import {
  hasFilters,
  readFilters,
  resetFilters,
  states,
  toQuery,
  writeFilters,
  type ListFilters,
  type State,
} from "./filters";
import { LabelBadges } from "../labels/LabelParts";
import { PriorityBadge, RepeatMark, StatusBadge } from "./IssueBadges";
import { SavedViewBar } from "../views/SavedViewBar";
import { IssueFilterBar } from "./IssueFilterBar";
import { ExportCsvButton } from "./ExportCsvButton";
import { useIssueReferences } from "./useIssueReferences";
import { isIssueShortcut } from "./issueKeyboard";
import "./issues.css";

const PAGE_SIZE = 50;

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
  const {
    projects,
    labels,
    milestones,
    loaded: referencesLoaded,
  } = useIssueReferences(desktop);
  const [loadError, setLoadError] = useState("");
  const [request, setRequest] = useState(0);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const titleInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const filterGroup = useRef<HTMLDivElement>(null);
  const issueList = useRef<HTMLUListElement>(null);
  const focusNewIssue = Boolean(
    (location.state as { focusNewIssue?: boolean } | null)?.focusNewIssue,
  );

  useEffect(() => {
    if (focusNewIssue) titleInput.current?.focus();
  }, [focusNewIssue]);

  useEffect(() => {
    if (!desktop) return;
    function focusSearch(event: KeyboardEvent) {
      if (!isIssueShortcut(event, "KeyF")) return;
      event.preventDefault();
      searchInput.current?.focus();
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [desktop]);

  function moveBetweenRows(event: ReactKeyboardEvent<HTMLUListElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!(event.target instanceof HTMLElement)) return;
    const className = event.target.matches(".issue-title")
      ? "issue-title"
      : event.target.matches(".issue-toggle")
        ? "issue-toggle"
        : null;
    if (!className) return;
    const controls = [
      ...(issueList.current?.querySelectorAll<HTMLElement>(`.${className}`) ??
        []),
    ];
    const index = controls.indexOf(event.target);
    const next = controls[index + (event.key === "ArrowDown" ? 1 : -1)];
    event.preventDefault();
    next?.focus();
  }

  function leaveField(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    filterGroup.current
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?.focus();
  }
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<number | null>(null);
  // Where the next page starts in the server's ordering. Issues that leave
  // the current state after a quick toggle shift later pages back by one.
  const nextOffset = useRef(0);
  const latestKey = useRef(queryKey);
  useEffect(() => {
    latestKey.current = queryKey;
  });

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
    setParams(writeFilters({ ...filters, ...changes }, params.get("view")), {
      replace: true,
    });
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
  const milestoneTitles = new Map(
    milestones.map(({ id, title }) => [id, title]),
  );
  const from = `${location.pathname}${location.search}`;
  const filtered = hasFilters(filters);
  const empty = counts !== null && counts.all === 0;
  const loading = results !== null && results.key !== `${queryKey}#${request}`;

  return (
    <div className="issues">
      <details className="issue-shortcuts">
        <summary>Keyboard shortcuts</summary>
        <ul>
          <li>
            <kbd>Alt/Option</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> to focus New
            issue
          </li>
          <li>
            <kbd>Alt/Option</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd> to focus
            issue search
          </li>
          <li>
            <kbd>↑</kbd> or <kbd>↓</kbd> to move between focused issue links or
            completion buttons
          </li>
          <li>
            <kbd>Enter</kbd> to open a focused issue, or <kbd>Space</kbd> to use
            its completion button
          </li>
          <li>
            <kbd>Escape</kbd> to leave a capture or search field
          </li>
        </ul>
      </details>
      <form className="issue-create" onSubmit={create}>
        <label htmlFor="new-issue-title">New issue</label>
        <div>
          <input
            id="new-issue-title"
            onKeyDown={leaveField}
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

      {!projectId && (
        <SavedViewBar
          kind="list"
          projects={projects}
          labels={labels}
          milestones={milestones}
          referencesLoaded={referencesLoaded}
        />
      )}
      <IssueFilterBar
        filters={filters}
        onChange={update}
        onReset={() =>
          setParams(writeFilters(resetFilters(filters), params.get("view")), {
            replace: true,
          })
        }
        projectId={projectId}
        projects={projects}
        labels={labels}
        milestones={milestones}
        searchRef={searchInput}
        onSearchKeyDown={leaveField}
      />

      <div className="issue-list-tools">
        <div
          ref={filterGroup}
          className="issue-filters"
          role="group"
          aria-label="Show issues"
        >
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
        {desktop && <ExportCsvButton query={query} />}
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
          ref={issueList}
          onKeyDown={moveBetweenRows}
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
                  {issue.recurring && <RepeatMark />}
                  {issue.archivedAt && (
                    <span className="issue-archived">Archived</span>
                  )}
                  {issue.milestoneId &&
                    milestoneTitles.has(issue.milestoneId) && (
                      <span className="issue-milestone">
                        <Flag size={13} aria-hidden="true" />
                        <span className="visually-hidden">Milestone: </span>
                        {milestoneTitles.get(issue.milestoneId)}
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
