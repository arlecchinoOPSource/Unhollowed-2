import type { Period } from "./controls";
import { queryKey, useSharedQuery } from "../../database/sharedQuery";
import { Link } from "react-router";
import {
  analyticsError,
  getProgressAnalytics,
  type ProgressTotals,
  type TrendBucket,
} from "../../database/analytics";
import { deviceZone } from "../../database/events";
import { fullDate } from "../calendar/monthGrid";

const SOURCES = ["issues", "projects", "milestones"] as const;

const W = 640;
const H = 150;
const PAD = { left: 36, right: 8, top: 10, bottom: 22 };

const plural = (count: number, one: string) =>
  `${count} ${count === 1 ? one : `${one}s`}`;
const rate = (value: number | null) =>
  value === null ? "No issues yet" : `${Math.round(value)}%`;

/** Issues-list URL with the same project filter a card was computed with. */
function issuesLink(
  project: string | null,
  extra: Record<string, string> = {},
) {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  return `/issues${query ? `?${query}` : ""}`;
}

function Trend({
  buckets,
  granularity,
}: {
  buckets: TrendBucket[];
  granularity: string;
}) {
  const peak = Math.max(1, ...buckets.map((b) => b.completed));
  const inner = W - PAD.left - PAD.right;
  const slot = inner / Math.max(buckets.length, 1);
  const width = Math.max(Math.min(slot - 1, 24), 1);
  const base = H - PAD.bottom;
  const scale = (base - PAD.top) / peak;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      className="dash-chart"
      aria-label={`Issues completed per ${granularity}, ${buckets[0] ? fullDate(buckets[0].start) : ""} to ${buckets.length ? fullDate(buckets[buckets.length - 1].end) : ""}, highest ${peak}. A data table follows.`}
    >
      <g className="dash-axes" aria-hidden="true">
        {[0, peak].map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={base - tick * scale}
              y2={base - tick * scale}
            />
            <text x={PAD.left - 6} y={base - tick * scale + 4} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}
      </g>
      {buckets.map((bucket, index) => (
        <rect
          key={bucket.start}
          className={bucket.completed === 0 ? "dash-zero" : "dash-bar"}
          x={PAD.left + index * slot + (slot - width) / 2}
          y={base - Math.max(bucket.completed * scale, 2)}
          width={width}
          height={Math.max(bucket.completed * scale, 2)}
        >
          <title>{`${fullDate(bucket.start)}${bucket.start === bucket.end ? "" : ` to ${fullDate(bucket.end)}`}: ${plural(bucket.completed, "issue")} completed`}</title>
        </rect>
      ))}
    </svg>
  );
}

function Counts({
  totals,
  project,
}: {
  totals: ProgressTotals;
  project: string | null;
}) {
  return (
    <>
      <td>
        <Link to={issuesLink(project)}>{totals.open}</Link>
      </td>
      <td>
        <Link to={issuesLink(project, { state: "closed", status: "done" })}>
          {totals.done}
        </Link>
      </td>
      <td>
        <Link to={issuesLink(project, { due: "overdue" })}>
          {totals.overdue}
        </Link>
      </td>
      <td>{rate(totals.completionPercent)}</td>
    </>
  );
}

/**
 * Project and issue progress from `get_progress_analytics`. Every number is
 * the engine's, computed with the project overview's denominators, and every
 * count links to the issue list under the same project filter. The trend
 * shows only what stored completion times can support and says how many
 * completed issues it could not place. docs/ANALYTICS.md, "Progress".
 */
export function ProgressSection({
  project,
  period,
}: {
  project: string | null;
  period: Period;
}) {
  const {
    data,
    error,
    retry: reload,
  } = useSharedQuery(
    queryKey(
      "progress-analytics",
      period.from,
      period.to,
      project,
      deviceZone(),
    ),
    SOURCES,
    () => getProgressAnalytics(period.from, period.to, project, deviceZone()),
    analyticsError,
  );

  return (
    <section aria-labelledby="progress-title" className="dash-section">
      <div className="dash-head">
        <h2 id="progress-title">Projects and issues</h2>
        <Link to={issuesLink(project)}>Open issues</Link>
        <Link to="/projects">Open projects</Link>
      </div>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="action" onClick={() => reload()}>
            Retry
          </button>
        </div>
      )}
      {!data && !error && <p>Loading progress…</p>}
      {data && data.totals.total === 0 && data.projects.length === 0 && (
        <p>No issues or projects yet. Progress appears once you add some.</p>
      )}
      {data && (data.totals.total > 0 || data.projects.length > 0) && (
        <>
          <p>
            As of {fullDate(data.today)}. Archived issues are not counted, and
            canceled issues are neither done nor outstanding.
          </p>
          <dl className="dash-tiles">
            <div>
              <dt>Open issues</dt>
              <dd>
                <Link to={issuesLink(data.projectId)}>{data.totals.open}</Link>{" "}
                of {data.totals.total}
              </dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>
                <Link
                  to={issuesLink(data.projectId, {
                    state: "closed",
                    status: "done",
                  })}
                >
                  {data.totals.done}
                </Link>
              </dd>
            </div>
            <div>
              <dt>Overdue</dt>
              <dd>
                <Link to={issuesLink(data.projectId, { due: "overdue" })}>
                  {data.totals.overdue}
                </Link>
              </dd>
            </div>
            <div>
              <dt>Completion rate</dt>
              <dd>{rate(data.totals.completionPercent)}</dd>
            </div>
          </dl>

          <h3>Projects</h3>
          {data.projects.length === 0 ? (
            <p>No projects.</p>
          ) : (
            <table className="dash-table">
              <caption className="visually-hidden">Progress by project</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Open</th>
                  <th scope="col">Done</th>
                  <th scope="col">Overdue</th>
                  <th scope="col">Completion</th>
                  <th scope="col">Milestones closed</th>
                  <th scope="col">Objective issues done</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((item) => (
                  <tr key={item.projectId}>
                    <th scope="row">
                      <Link to={`/projects/${item.projectId}`}>
                        {item.name}
                      </Link>
                    </th>
                    <Counts totals={item.issues} project={item.projectId} />
                    <td>
                      {item.milestonesClosed} of{" "}
                      {item.milestonesOpen + item.milestonesClosed}
                    </td>
                    <td>
                      {item.objectiveLinked === 0
                        ? "No linked issues"
                        : `${item.objectiveDone} of ${item.objectiveLinked}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Deadlines</h3>
          {data.deadlines.length === 0 ? (
            <p>Nothing overdue or due in the next 14 days.</p>
          ) : (
            <ul className="dash-deadlines" aria-label="Deadlines">
              {data.deadlines.map((deadline) => (
                <li key={`${deadline.kind}-${deadline.id}`}>
                  {fullDate(deadline.dueDate)}
                  {deadline.overdue ? " (overdue)" : ""}:{" "}
                  {deadline.kind === "issue" ? (
                    <Link to={`/issues/${deadline.id}`}>
                      ISS-{deadline.number} {deadline.title}
                    </Link>
                  ) : (
                    <Link to={`/issues/milestones`}>
                      Milestone {deadline.title}
                    </Link>
                  )}
                  {deadline.projectName ? `, ${deadline.projectName}` : ""}
                </li>
              ))}
            </ul>
          )}

          <h3>Completed over time</h3>
          <p>
            {fullDate(data.from)} to {fullDate(data.to)}, by{" "}
            {data.trend.granularity}. Counts issues that are done now, on the
            day they were completed. An issue that was reopened or canceled
            later is no longer counted.
          </p>
          {data.trend.withoutTime > 0 && (
            <p role="note">
              {plural(data.trend.withoutTime, "completed issue")} of{" "}
              {data.trend.doneTotal} have no stored completion time, so they are
              not in this chart.
            </p>
          )}
          <Trend
            buckets={data.trend.buckets}
            granularity={data.trend.granularity}
          />
          <details className="dash-details">
            <summary>Data table: completed over time</summary>
            <table className="dash-table">
              <caption className="visually-hidden">
                Issues completed per {data.trend.granularity}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Completed</th>
                </tr>
              </thead>
              <tbody>
                {data.trend.buckets.map((bucket) => (
                  <tr key={bucket.start}>
                    <th scope="row">
                      {bucket.start === bucket.end
                        ? fullDate(bucket.start)
                        : `${fullDate(bucket.start)} to ${fullDate(bucket.end)}`}
                    </th>
                    <td>{bucket.completed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}
