import { Circle, CircleCheck, ListTodo, Plus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import {
  completeIssue,
  createIssue,
  issueError,
  issueKey,
  listIssues,
  reopenIssue,
  type IssueSummary,
} from "../../database/issues";
import { listProjects, type Project } from "../../database/projects";
import { isTauri } from "../../database/status";
import { PriorityBadge, StatusBadge } from "./IssueBadges";
import "./issues.css";

const filters = { open: "Open", closed: "Closed", all: "All" } as const;
type Filter = keyof typeof filters;

function readFilter(value: string | null): Filter {
  return value === "closed" || value === "all" ? value : "open";
}

/**
 * The issue list used by All Issues and by each project's issue page. Open
 * and closed follow the backend's derived `closed` field. The filter lives in
 * the URL so it survives opening an issue and coming back.
 */
export function IssueList({ projectId }: { projectId?: string }) {
  const desktop = isTauri();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const filter = readFilter(params.get("state"));
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadError, setLoadError] = useState("");
  const [request, setRequest] = useState(0);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const titleInput = useRef<HTMLInputElement>(null);
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<number | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    Promise.all([listIssues(projectId), listProjects()]).then(
      ([loadedIssues, loadedProjects]) => {
        if (!current) return;
        setIssues(loadedIssues);
        setProjects(loadedProjects);
      },
      (cause) => {
        if (current) setLoadError(issueError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, projectId, request]);

  const visible =
    issues?.filter(
      (issue) => filter === "all" || (filter === "closed") === issue.closed,
    ) ?? [];
  const counts = {
    open: issues?.filter((issue) => !issue.closed).length ?? 0,
    closed: issues?.filter((issue) => issue.closed).length ?? 0,
    all: issues?.length ?? 0,
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
    if (creating) return;
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
      setIssues((list) => [issue, ...(list ?? [])]);
      setTitle("");
      setMessage(`Created ${issueKey(issue)}.`);
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
      if (filter !== "all" && updated.closed !== issue.closed) {
        pendingFocus.current = index;
      }
      setIssues((list) =>
        (list ?? []).map((item) => (item.id === updated.id ? updated : item)),
      );
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
  const from = `${location.pathname}${location.search}`;

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
          <button className="action" type="submit" aria-disabled={creating}>
            <Plus size={16} aria-hidden="true" />
            {creating ? "Creating…" : "Create issue"}
          </button>
        </div>
      </form>
      {actionError && <p role="alert">{actionError}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>
      <div className="issue-filters" role="group" aria-label="Show issues">
        {(Object.keys(filters) as Filter[]).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={filter === value}
            onClick={() =>
              setParams(value === "open" ? {} : { state: value }, {
                replace: true,
              })
            }
          >
            {filters[value]}
            {issues && <span className="issue-count">{counts[value]}</span>}
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
      {!loadError && issues === null && <p>Loading issues…</p>}
      {issues?.length === 0 && (
        <div className="issues-empty">
          <ListTodo size={24} aria-hidden="true" />
          <h2>
            {projectId ? "No issues in this project yet" : "No issues yet"}
          </h2>
          <p>Create an issue to start tracking your work.</p>
        </div>
      )}
      {issues && issues.length > 0 && visible.length === 0 && (
        <p>{filter === "closed" ? "No closed issues." : "No open issues."}</p>
      )}
      {visible.length > 0 && (
        <ul className="issue-list" aria-label={`${filters[filter]} issues`}>
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
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
