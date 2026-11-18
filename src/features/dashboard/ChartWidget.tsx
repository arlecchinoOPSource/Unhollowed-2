import { useLocation, useNavigate } from "react-router";
import { safeBack } from "../../app/links";
import { Chart, type Point } from "../../components/charts/Chart";
import { NOTES, completedIssues, habitDays, scheduledTime } from "./drilldown";
import {
  analyticsError,
  getProgressAnalytics,
  getScheduleAnalytics,
} from "../../database/analytics";
import { deviceZone } from "../../database/events";
import { getHabitStatistics, habitError } from "../../database/habits";
import { queryKey, useSharedQuery } from "../../database/sharedQuery";
import { fullDate } from "../calendar/monthGrid";
import type { WidgetContext } from "./WidgetHost";

const count = (n: number) => `${n} ${n === 1 ? "issue" : "issues"}`;
const percent = (n: number) => `${Math.round(n)}%`;
function minutes(n: number): string {
  const hours = Math.floor(n / 60);
  const rest = n % 60;
  return [hours ? `${hours} h` : "", rest || !hours ? `${rest} min` : ""]
    .filter(Boolean)
    .join(" ");
}

const range = (context: WidgetContext) =>
  `${fullDate(context.period.from)} to ${fullDate(context.period.to)}`;

/** A bucket's label: its day, or the week it starts. */
const label = (start: string, end: string) =>
  start === end ? fullDate(start) : `Week of ${fullDate(start)}`;

type Kind = "bar" | "line";

/** Opens a drilldown and remembers the dashboard to return to. */
function useOpen() {
  const navigate = useNavigate();
  const location = useLocation();
  return (to: string) =>
    navigate(to, {
      state: {
        from: safeBack(`${location.pathname}${location.search}`, "/dashboards"),
      },
    });
}

function Frame({
  title,
  error,
  retry,
  children,
}: {
  title: string;
  error: string;
  retry: () => void;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="dash-section">
      <h2>{title}</h2>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="action" onClick={retry}>
            Retry
          </button>
        </div>
      ) : (
        children
      )}
    </section>
  );
}

function IssuesCompleted({
  kind,
  context,
}: {
  kind: Kind;
  context: WidgetContext;
}) {
  const { period, project } = context;
  const { data, error, retry } = useSharedQuery(
    queryKey(
      "progress-analytics",
      period.from,
      period.to,
      project,
      deviceZone(),
    ),
    ["issues", "projects", "milestones"],
    () => getProgressAnalytics(period.from, period.to, project, deviceZone()),
    analyticsError,
  );
  const points: Point[] =
    data?.trend.buckets.map((b) => ({
      label: label(b.start, b.end),
      value: b.completed,
    })) ?? [];
  const empty = data !== null && points.every((p) => !p.value);
  const open = useOpen();
  const buckets = data?.trend.buckets ?? [];
  return (
    <Frame title="Issues completed" error={error} retry={retry}>
      {data === null ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          <Chart
            kind={kind}
            title="Issues completed"
            range={range(context)}
            format={count}
            series={[{ name: "Completed", accent: "periwinkle", points }]}
            drill={(_, i) =>
              buckets[i] && buckets[i].completed > 0
                ? completedIssues(buckets[i], buckets[i].completed, project)
                : null
            }
            onOpen={open}
            state={empty ? "empty" : "ready"}
            message="No issues were completed in this period."
          />
          {data.trend.withoutTime > 0 && (
            <p>
              {data.trend.withoutTime} of {data.trend.doneTotal} done issues
              have no completion time and are not placed on the chart.
            </p>
          )}
        </>
      )}
    </Frame>
  );
}

function ScheduledTime({
  kind,
  context,
}: {
  kind: Kind;
  context: WidgetContext;
}) {
  const { period, project } = context;
  const { data, error, retry } = useSharedQuery(
    queryKey(
      "schedule-analytics",
      period.from,
      period.to,
      project,
      deviceZone(),
    ),
    ["calendar", "issues", "projects"],
    () => getScheduleAnalytics(period.from, period.to, project, deviceZone()),
    analyticsError,
  );
  const buckets = data && (data.days.length > 92 ? data.weeks : data.days);
  const points: Point[] =
    buckets?.map((b) => ({
      label: label(b.start, b.end),
      value: b.busyMinutes,
    })) ?? [];
  const empty = data !== null && points.every((p) => !p.value);
  const open = useOpen();
  return (
    <Frame title="Scheduled time" error={error} retry={retry}>
      {data === null ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          <Chart
            kind={kind}
            title="Scheduled time"
            range={range(context)}
            format={minutes}
            series={[{ name: "Busy time", accent: "green", points }]}
            drill={(_, i) =>
              buckets?.[i] && buckets[i].busyMinutes > 0
                ? scheduledTime(buckets[i])
                : null
            }
            onOpen={open}
            state={empty ? "empty" : "ready"}
            message="Nothing is scheduled in this period."
          />
          <p>Scheduled, not time worked.</p>
        </>
      )}
    </Frame>
  );
}

function HabitCompletion({
  kind,
  context,
}: {
  kind: Kind;
  context: WidgetContext;
}) {
  const { period, project, habit } = context;
  const { data, error, retry } = useSharedQuery(
    project
      ? null
      : queryKey("habit-statistics", period.from, period.to, habit),
    ["habits"],
    () => getHabitStatistics(period.from, period.to, habit ? [habit] : null),
    habitError,
  );
  const buckets = data && (data.days.length ? data.days : data.weeks);
  const points: Point[] =
    buckets?.map((b) => ({
      label: label(b.start, b.end),
      value: b.percent,
    })) ?? [];
  const empty = data !== null && points.every((p) => p.value === null);
  const open = useOpen();
  return (
    <Frame title="Habit completion" error={error} retry={retry}>
      {project ? (
        <Chart
          kind={kind}
          title="Habit completion"
          range={range(context)}
          format={percent}
          series={[]}
          state="unavailable"
          message="Habits are not part of a project, so they are left out while a project is selected."
        />
      ) : data === null ? (
        <p role="status">Loading…</p>
      ) : (
        <Chart
          kind={kind}
          title="Habit completion"
          range={range(context)}
          format={percent}
          max={100}
          series={[{ name: "Completed", accent: "violet", points }]}
          drill={(_, i) =>
            buckets?.[i] && buckets[i].percent !== null
              ? habitDays(buckets[i], habit)
              : null
          }
          onOpen={open}
          aggregateNote={habit ? undefined : NOTES.habits}
          state={empty ? "empty" : "ready"}
          message="No habits were due in this period."
        />
      )}
    </Frame>
  );
}

/** A line or bar chart of one measure, from the same queries as the sections. */
export function ChartWidget({
  kind,
  metric,
  context,
}: {
  kind: Kind;
  metric: string;
  context: WidgetContext;
}) {
  switch (metric) {
    case "scheduled-time":
      return <ScheduledTime kind={kind} context={context} />;
    case "habit-completion":
      return <HabitCompletion kind={kind} context={context} />;
    default:
      return <IssuesCompleted kind={kind} context={context} />;
  }
}
