import { ArrowUpRight, Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { links } from "../../app/links";
import { analyticsError, getProgressAnalytics } from "../../database/analytics";
import { loadLibrary } from "../../database/documentLibrary";
import { deviceZone } from "../../database/events";
import {
  getHabitMonth,
  habitError,
  setHabitCompletion,
} from "../../database/habits";
import {
  issueError,
  queryIssues,
  type IssueQuery,
} from "../../database/issues";
import { listProjects, projectError } from "../../database/projects";
import { queryKey, useSharedQuery } from "../../database/sharedQuery";
import { shortDate } from "../calendar/monthGrid";
import { localDate } from "../today/dates";
import { activeProjects, habitsDue, LIMIT, recentDocuments } from "./homeData";

/** One Home section: its own loading, error with retry, and empty state. */
function Section({
  id,
  title,
  to,
  open,
  error,
  retry,
  loading,
  empty,
  children,
}: {
  id: string;
  title: string;
  to: string;
  open: string;
  error: string;
  retry: () => void;
  loading: boolean;
  empty: ReactNode | null;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="home-section">
      <div className="home-head">
        <h2 id={id}>{title}</h2>
        <Link to={to} className="home-open" aria-label={open} title={open}>
          <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      </div>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="action" onClick={retry}>
            Retry
          </button>
        </div>
      ) : loading ? (
        <p role="status" className="home-loading">
          Loading…
        </p>
      ) : (
        (empty ?? children)
      )}
    </section>
  );
}

const SOURCES = ["issues", "projects", "milestones"] as const;

function IssueSection({
  id,
  title,
  today,
  query,
  to,
  open,
  empty,
  showUpdated = false,
}: {
  id: string;
  title: string;
  today: string;
  query: IssueQuery;
  to: string;
  open: string;
  empty: string;
  /** Say when each issue last changed, for lists ordered by activity. */
  showUpdated?: boolean;
}) {
  const { data, error, loading, retry } = useSharedQuery(
    queryKey("home-issues", id, today, query),
    ["issues", "projects", "milestones"],
    () => queryIssues({ ...query, limit: LIMIT }),
    issueError,
  );
  return (
    <Section
      id={id}
      title={title}
      to={to}
      open={open}
      error={error}
      retry={retry}
      loading={data === null && loading}
      empty={
        data && data.total === 0 ? <p className="home-empty">{empty}</p> : null
      }
    >
      {data && (
        <>
          <ul className="home-list">
            {data.issues.map((issue) => (
              <li key={issue.id}>
                <Link to={links.issue(issue.id)} state={{ from: "/" }}>
                  <span className="home-key">ISS-{issue.number}</span>{" "}
                  {issue.title}
                </Link>
                {showUpdated ? (
                  <span className="home-meta">
                    updated{" "}
                    {shortDate(localDate(new Date(issue.updatedAt)), today)}
                  </span>
                ) : (
                  issue.dueDate && (
                    <span className="home-meta">
                      due {shortDate(issue.dueDate, today)}
                    </span>
                  )
                )}
              </li>
            ))}
          </ul>
          {data.total > data.issues.length && (
            <p className="home-more">
              <Link to={to}>{data.total - data.issues.length} more</Link>
            </p>
          )}
        </>
      )}
    </Section>
  );
}

/** Overdue work first, then what is due today, by priority. */
export function Attention({ today }: { today: string }) {
  return (
    <>
      <IssueSection
        id="home-overdue"
        title="Overdue"
        today={today}
        query={{
          state: "open",
          dueBefore: addDay(today, -1),
          undated: "exclude",
          sort: "due",
          direction: "asc",
        }}
        to="/issues?due=overdue"
        open="Open overdue issues"
        empty="Nothing is overdue."
      />
      <IssueSection
        id="home-due-today"
        title="Due today"
        today={today}
        query={{
          state: "open",
          dueAfter: today,
          dueBefore: today,
          undated: "exclude",
          sort: "priority",
          direction: "desc",
        }}
        to="/issues?due=today"
        open="Open issues due today"
        empty="Nothing is due today."
      />
    </>
  );
}

/** Issues marked in progress, most recently changed first: where to resume. */
export function InProgress({ today }: { today: string }) {
  return (
    <IssueSection
      id="home-in-progress"
      title="In progress"
      today={today}
      query={{
        state: "open",
        statuses: ["in_progress"],
        sort: "updated",
        direction: "desc",
      }}
      to="/issues?status=in_progress"
      open="Open in-progress issues"
      empty="No issues are in progress."
      showUpdated
    />
  );
}

function addDay(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number);
  const out = new Date(y, m - 1, d + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${out.getFullYear()}-${pad(out.getMonth() + 1)}-${pad(out.getDate())}`;
}

/** Habits that can be completed today and whether each is. */
export function HabitsToday({ today }: { today: string }) {
  const [year, month] = today.split("-").map(Number);
  const { data, error, loading, retry } = useSharedQuery(
    queryKey("home-habits", today),
    ["habits"],
    () => getHabitMonth(year, month),
    habitError,
  );
  const [problem, setProblem] = useState("");
  async function toggle(id: string, done: boolean) {
    setProblem("");
    try {
      await setHabitCompletion(id, today, !done);
    } catch (cause) {
      setProblem(habitError(cause));
    }
  }
  const due = data ? habitsDue(data.habits, today) : [];
  const done = new Set(
    data?.completions.filter((c) => c.date === today).map((c) => c.habitId),
  );
  return (
    <Section
      id="home-habits"
      title="Habits today"
      to="/habits"
      open="Open habits"
      error={error}
      retry={retry}
      loading={data === null && loading}
      empty={
        data && due.length === 0 ? (
          <p className="home-empty">No habits to do today.</p>
        ) : null
      }
    >
      <ul className="home-list home-habits">
        {due.slice(0, 10).map((habit) => (
          <li key={habit.id}>
            <button
              type="button"
              className="home-check"
              aria-pressed={done.has(habit.id)}
              aria-label={`${done.has(habit.id) ? "Undo" : "Mark done"}: ${habit.name}`}
              title={done.has(habit.id) ? "Undo" : "Mark done"}
              onClick={() => toggle(habit.id, done.has(habit.id))}
            >
              <Check size={14} strokeWidth={3} aria-hidden="true" />
            </button>
            <Link to={links.habit(habit.id, today)}>{habit.name}</Link>
          </li>
        ))}
      </ul>
      {problem && <p role="alert">{problem}</p>}
      {due.length > 0 && (
        <div className="home-progress">
          <span
            className="home-progress-bar"
            aria-hidden="true"
            style={{
              width: `${(100 * due.filter((h) => done.has(h.id)).length) / due.length}%`,
            }}
          />
          <p>
            {due.filter((h) => done.has(h.id)).length} of {due.length} done
            today.
          </p>
        </div>
      )}
    </Section>
  );
}

/** Open milestones that are overdue or due within two weeks. */
export function Milestones({ today }: { today: string }) {
  const zone = deviceZone();
  const { data, error, loading, retry } = useSharedQuery(
    queryKey("progress-analytics", today, today, null, zone),
    SOURCES,
    () => getProgressAnalytics(today, today, null, zone),
    analyticsError,
  );
  const items = (data?.deadlines ?? [])
    .filter((d) => d.kind === "milestone")
    .sort(
      (a, b) =>
        a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title),
    );
  return (
    <Section
      id="home-milestones"
      title="Upcoming milestones"
      to="/issues/milestones"
      open="Open milestones"
      error={error}
      retry={retry}
      loading={data === null && loading}
      empty={
        data && items.length === 0 ? (
          <p className="home-empty">Nothing due in the next two weeks.</p>
        ) : null
      }
    >
      <ul className="home-list">
        {items.slice(0, LIMIT).map((m) => (
          <li key={m.id}>
            <Link
              to={
                m.projectId
                  ? `/issues/milestones?project=${encodeURIComponent(m.projectId)}`
                  : "/issues/milestones"
              }
            >
              {m.title}
            </Link>
            <span className="home-meta">
              {m.overdue ? "was due" : "due"} {shortDate(m.dueDate, today)}
              {m.projectName ? ` · ${m.projectName}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The documents opened or changed most recently. */
export function RecentDocuments({ today }: { today: string }) {
  const { data, error, loading, retry } = useSharedQuery(
    queryKey("home-documents", today),
    [],
    loadLibrary,
    () => "Could not read documents. Try again.",
  );
  const docs = data ? recentDocuments(data.documents) : [];
  return (
    <Section
      id="home-documents"
      title="Recent documents"
      to="/documents"
      open="Open documents"
      error={error}
      retry={retry}
      loading={data === null && loading}
      empty={
        data && docs.length === 0 ? (
          <p className="home-empty">No documents yet.</p>
        ) : null
      }
    >
      <ul className="home-list">
        {docs.map((doc) => (
          <li key={doc.id}>
            <Link
              to={links.document(doc.id)}
              state={{ from: "/", fromLabel: "Home" }}
            >
              {doc.title || "Untitled"}
            </Link>
            <span className="home-meta">
              {doc.openedAt
                ? `opened ${shortDate(localDate(new Date(doc.openedAt)), today)}`
                : `changed ${shortDate(localDate(new Date(doc.updatedAt)), today)}`}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Active projects, most recently changed first. */
export function ActiveProjects({ today }: { today: string }) {
  const { data, error, loading, retry } = useSharedQuery(
    queryKey("home-projects", today),
    ["projects"],
    listProjects,
    projectError,
  );
  const projects = data ? activeProjects(data) : [];
  return (
    <Section
      id="home-projects"
      title="Active projects"
      to="/projects"
      open="Open projects"
      error={error}
      retry={retry}
      loading={data === null && loading}
      empty={
        data && projects.length === 0 ? (
          <p className="home-empty">No active projects.</p>
        ) : null
      }
    >
      <ul className="home-list">
        {projects.map((project) => (
          <li key={project.id}>
            <Link to={links.project(project.id)}>{project.name}</Link>
            <Link
              to={links.projectIssues(project.id)}
              className="home-meta home-chip"
            >
              Issues
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
