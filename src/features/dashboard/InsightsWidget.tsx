import { Link } from "react-router";
import {
  analyticsError,
  getProgressAnalytics,
  getScheduleAnalytics,
  getWorkspaceAnalytics,
} from "../../database/analytics";
import { deviceZone } from "../../database/events";
import { getHabitStatistics, habitError } from "../../database/habits";
import { queryKey, useSharedQuery } from "../../database/sharedQuery";
import { addDays, localDate } from "../today/dates";
import { buildInsights } from "./insights";
import type { WidgetContext } from "./WidgetHost";

/**
 * Short statements about what needs attention, built by fixed rules from the
 * same shared queries as the other widgets. Every statement links to the
 * records it came from. No predictions, scores, or advice.
 */
export function InsightsWidget({ context }: { context: WidgetContext }) {
  const { period, project, habit } = context;
  const today = localDate(new Date());
  const tomorrow = addDays(today, 1);
  const zone = deviceZone();

  const progress = useSharedQuery(
    queryKey("progress-analytics", period.from, period.to, project, zone),
    ["issues", "projects", "milestones"],
    () => getProgressAnalytics(period.from, period.to, project, zone),
    analyticsError,
  );
  const workspace = useSharedQuery(
    queryKey("workspace-analytics", period.from, period.to, project, zone),
    ["issues", "projects", "milestones", "calendar", "habits"],
    () => getWorkspaceAnalytics(period.from, period.to, project, zone),
    analyticsError,
  );
  const habits = useSharedQuery(
    project
      ? null
      : queryKey("habit-statistics", period.from, period.to, habit),
    ["habits"],
    () => getHabitStatistics(period.from, period.to, habit ? [habit] : null),
    habitError,
  );
  const schedule = useSharedQuery(
    queryKey("schedule-analytics", tomorrow, tomorrow, project, zone),
    ["calendar", "issues", "projects"],
    () => getScheduleAnalytics(tomorrow, tomorrow, project, zone),
    analyticsError,
  );

  const insights = buildInsights({
    today,
    tomorrow,
    period,
    project,
    progress: progress.data,
    workspace: workspace.data,
    habits: habits.data,
    schedule: schedule.data,
  });
  const errors = [progress, workspace, habits, schedule]
    .map((q) => q.error)
    .filter(Boolean);
  const loading = [progress, workspace, schedule].some(
    (q) => q.data === null && !q.error,
  );

  return (
    <section aria-label="Insights" className="dash-section">
      <h2>Insights</h2>
      {errors.length > 0 && (
        <div role="alert">
          <p>
            Some statements are left out because their data could not be read.
          </p>
          <button
            type="button"
            className="action"
            onClick={() => {
              progress.retry();
              workspace.retry();
              habits.retry();
              schedule.retry();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {loading && insights.length === 0 && errors.length === 0 && (
        <p role="status">Loading…</p>
      )}
      {project && (
        <p>
          Habit statements are left out while a project is selected: habits are
          not part of a project.
        </p>
      )}
      <ul className="dash-insights">
        {insights.map((item) => (
          <li key={item.id}>
            {item.text} <Link to={item.to}>{item.action}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
