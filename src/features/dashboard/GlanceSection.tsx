import type { Period } from "./controls";
import { queryKey, useSharedQuery } from "../../database/sharedQuery";
import { Link } from "react-router";
import {
  analyticsError,
  getWorkspaceAnalytics,
} from "../../database/analytics";
import { deviceZone } from "../../database/events";

const SOURCES = [
  "issues",
  "projects",
  "milestones",
  "calendar",
  "habits",
] as const;

function span(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} h` : "", rest || !hours ? `${rest} min` : ""]
    .filter(Boolean)
    .join(" ");
}

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

/**
 * The cards at the top: one read of `get_workspace_analytics` for the shared
 * period and project filter. Every card links to the records or view that
 * explain it. A source that does not apply to the filter says so.
 */
export function GlanceSection({
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
      "workspace-analytics",
      period.from,
      period.to,
      project,
      deviceZone(),
    ),
    SOURCES,
    () => getWorkspaceAnalytics(period.from, period.to, project, deviceZone()),
    analyticsError,
  );

  const issues = data?.issues.data;
  const habits = data?.habits;
  const calendar = data?.calendar.data;
  return (
    <section aria-labelledby="glance-title" className="dash-section">
      <h2 id="glance-title">At a glance</h2>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="action" onClick={() => reload()}>
            Retry
          </button>
        </div>
      )}
      {!data && !error && <p>Loading summary…</p>}
      {data && issues && calendar && habits && (
        <dl className="dash-tiles">
          <div>
            <dt>Open issues</dt>
            <dd>
              <Link to={issuesLink(project)}>{issues.open}</Link>
            </dd>
          </div>
          <div>
            <dt>Completed in this period</dt>
            <dd>
              <Link
                to={issuesLink(project, { state: "closed", status: "done" })}
              >
                {issues.completed}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Overdue</dt>
            <dd>
              <Link to={issuesLink(project, { due: "overdue" })}>
                {issues.overdue}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Habit completion</dt>
            <dd>
              {habits.availability === "not_applicable" || !habits.data ? (
                <>Not part of a project</>
              ) : habits.data.percent === null ? (
                <Link to="/habits">No eligible days</Link>
              ) : (
                <Link to="/habits">{Math.round(habits.data.percent)}%</Link>
              )}
            </dd>
          </div>
          <div>
            <dt>Scheduled this period</dt>
            <dd>
              <Link to={`/calendar?view=month&date=${period.to}`}>
                {calendar.events} {calendar.events === 1 ? "event" : "events"},{" "}
                {span(calendar.scheduledMinutes + calendar.workBlockMinutes)}
              </Link>
              {calendar.truncated ? " or more" : ""}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
