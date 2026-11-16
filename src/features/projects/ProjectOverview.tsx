import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  issueKey,
  issueStatuses,
  type IssueStatus,
  type IssueSummary,
} from "../../database/issues";
import { milestoneProgress } from "../../database/milestones";
import {
  getProjectOverview,
  type Activity,
  type ProjectOverview as Overview,
  type StatusCounts,
} from "../../database/overview";
import { StatusBadge } from "../issues/IssueBadges";
import { dayLabel } from "../today/dates";
import { useLocalToday } from "../today/useLocalToday";
import "./overview.css";

const statusKeys: Record<IssueStatus, keyof StatusCounts> = {
  todo: "todo",
  in_progress: "inProgress",
  blocked: "blocked",
  done: "done",
  canceled: "canceled",
};

const activityLabels: Record<Activity["kind"], string> = {
  created: "Created",
  completed: "Completed",
  updated: "Last updated",
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function timestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/**
 * What is underway, late, and next in a project. Every number is computed
 * from the project's issues when the page loads and links to the matching
 * issue list.
 */
export function ProjectOverview({ projectId }: { projectId: string }) {
  const today = useLocalToday();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let current = true;
    getProjectOverview(projectId, today).then(
      (loaded) => {
        if (current) setOverview(loaded);
      },
      () => {
        if (current) setError("Could not load the project overview.");
      },
    );
    return () => {
      current = false;
    };
  }, [projectId, today, request]);

  const issues = `/projects/${projectId}/issues`;
  if (error)
    return (
      <div role="alert" className="project-overview">
        <p>{error}</p>
        <button
          className="action"
          onClick={() => {
            setError("");
            setRequest(request + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  if (!overview) return <p>Loading overview…</p>;

  const counted = overview.total - overview.statuses.canceled;
  const largest = Math.max(1, ...Object.values(overview.statuses));

  return (
    <section className="project-overview" aria-labelledby="overview-heading">
      <h2 id="overview-heading">Overview</h2>
      <div className="overview-tiles">
        <div className="overview-tile">
          <span className="overview-label">Completion</span>
          {overview.completion === null ? (
            <>
              <span className="overview-number">—</span>
              <span className="overview-note">No issues yet</span>
            </>
          ) : (
            <>
              <span className="overview-number">
                {percent(overview.completion)}
              </span>
              <span className="overview-note">
                {overview.statuses.done} of {counted} done
                {overview.statuses.canceled > 0 &&
                  ", canceled issues not counted"}
              </span>
            </>
          )}
        </div>
        <Link className="overview-tile" to={issues}>
          <span className="overview-label">Open</span>
          <span className="overview-number">{overview.open}</span>
          <span className="overview-note">of {overview.total} issues</span>
        </Link>
        <Link className="overview-tile" to={`${issues}?state=closed`}>
          <span className="overview-label">Closed</span>
          <span className="overview-number">{overview.closed}</span>
          <span className="overview-note">done or canceled</span>
        </Link>
        <Link className="overview-tile" to={`${issues}?due=overdue`}>
          <span className="overview-label">Overdue</span>
          <span className="overview-number">{overview.overdueCount}</span>
          <span className="overview-note">open, past due</span>
        </Link>
        <Link className="overview-tile" to={`${issues}?due=week`}>
          <span className="overview-label">Due this week</span>
          <span className="overview-number">{overview.upcomingCount}</span>
          <span className="overview-note">today and the next 6 days</span>
        </Link>
      </div>

      <div className="overview-grid">
        <section aria-labelledby="overview-statuses">
          <h3 id="overview-statuses">Issues by status</h3>
          {overview.total === 0 ? (
            <p>No issues yet.</p>
          ) : (
            <ul className="overview-bars">
              {(Object.keys(issueStatuses) as IssueStatus[]).map((status) => {
                const count = overview.statuses[statusKeys[status]];
                return (
                  <li key={status}>
                    <Link
                      to={`${issues}?state=all&status=${status}`}
                      aria-label={`${issueStatuses[status]}: ${count} ${count === 1 ? "issue" : "issues"}`}
                    >
                      <StatusBadge status={status} />
                      <span className="overview-bar-track" aria-hidden="true">
                        {count > 0 && (
                          <span
                            className="overview-bar"
                            style={{ width: `${(count / largest) * 100}%` }}
                          />
                        )}
                      </span>
                      <span className="overview-count">{count}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {overview.undatedOpen > 0 && (
            <p className="overview-note">
              <Link to={`${issues}?due=none`}>
                {overview.undatedOpen} open{" "}
                {overview.undatedOpen === 1 ? "issue has" : "issues have"} no
                due date
              </Link>
            </p>
          )}
        </section>

        <IssueGroup
          id="overview-overdue"
          title="Overdue"
          issues={overview.overdue}
          total={overview.overdueCount}
          today={today}
          all={`${issues}?due=overdue`}
          empty="Nothing overdue."
        />
        <IssueGroup
          id="overview-upcoming"
          title="Coming up"
          issues={overview.upcoming}
          total={overview.upcomingCount}
          today={today}
          all={`${issues}?due=week`}
          empty="Nothing due in the next 7 days."
        />

        <section aria-labelledby="overview-milestones">
          <h3 id="overview-milestones">Milestones</h3>
          {overview.milestones.length === 0 ? (
            <p>
              No milestones for this project.{" "}
              <Link to={`/issues/milestones?project=${projectId}`}>
                Plan one
              </Link>
            </p>
          ) : (
            <ul className="overview-milestones">
              {overview.milestones.map((milestone) => {
                const progress = milestoneProgress(milestone);
                const contributing =
                  milestone.openCount + milestone.completedCount;
                return (
                  <li key={milestone.id}>
                    <Link to={`/issues?state=all&milestone=${milestone.id}`}>
                      {milestone.title}
                    </Link>
                    {milestone.closed && (
                      <span className="overview-note"> (closed)</span>
                    )}
                    {progress === null ? (
                      <span className="overview-note">No issues yet</span>
                    ) : (
                      <>
                        <progress
                          max={contributing}
                          value={milestone.completedCount}
                          aria-label={`Progress for ${milestone.title}`}
                        />
                        <span className="overview-note">
                          {milestone.completedCount} of {contributing} complete
                          ({percent(progress)})
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="overview-activity">
          <h3 id="overview-activity">Recent activity</h3>
          {overview.activity.length === 0 ? (
            <p>No activity yet.</p>
          ) : (
            <ul className="overview-activity">
              {overview.activity.map((event) => (
                <li key={`${event.kind}-${event.issueId}-${event.at}`}>
                  <span className="overview-kind">
                    {activityLabels[event.kind]}
                  </span>
                  <Link to={`/issues/${event.issueId}`}>
                    {issueKey(event)}: {event.title}
                  </Link>
                  <time dateTime={event.at}>{timestamp(event.at)}</time>
                </li>
              ))}
            </ul>
          )}
          <p className="overview-note">
            From each issue's created, completed, and last updated times.
          </p>
        </section>
      </div>
    </section>
  );
}

function IssueGroup({
  id,
  title,
  issues,
  total,
  today,
  all,
  empty,
}: {
  id: string;
  title: string;
  issues: IssueSummary[];
  total: number;
  today: string;
  all: string;
  empty: string;
}) {
  return (
    <section aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {issues.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <ul className="overview-issues">
          {issues.map((issue) => (
            <li key={issue.id}>
              <Link to={`/issues/${issue.id}`}>
                {issueKey(issue)}: {issue.title}
              </Link>
              {issue.dueDate && (
                <time dateTime={issue.dueDate}>
                  {dayLabel(issue.dueDate, today)}
                </time>
              )}
            </li>
          ))}
        </ul>
      )}
      {total > issues.length && (
        <Link to={all}>
          View all {total} {title.toLowerCase()}
        </Link>
      )}
    </section>
  );
}
