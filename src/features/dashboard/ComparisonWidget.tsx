import { useLocation, useNavigate } from "react-router";
import { Chart, type Drill, type Point } from "../../components/charts/Chart";
import { NOTES, completedIssues, habitDays, scheduledTime } from "./drilldown";
import {
  analyticsError,
  getProgressAnalytics,
  getScheduleAnalytics,
} from "../../database/analytics";
import { checkinError, getCheckinAnalytics } from "../../database/checkins";
import { deviceZone } from "../../database/events";
import { getHabitStatistics, habitError } from "../../database/habits";
import { queryKey, useSharedQuery } from "../../database/sharedQuery";
import { fullDate } from "../calendar/monthGrid";
import { localDate } from "../today/dates";
import {
  align,
  bucketsOf,
  fromEngine,
  type Aligned,
  type Bucket,
  type Grain,
} from "./comparison";
import type { WidgetContext } from "./WidgetHost";

const label = (b: Bucket, grain: Grain) =>
  grain === "month"
    ? fullDate(b.start).replace(/^\w+ \d+, /, "")
    : b.start === b.end
      ? fullDate(b.start)
      : `Week of ${fullDate(b.start)}`;

const minutes = (n: number) => {
  const hours = Math.floor(n / 60);
  const rest = n % 60;
  return [hours ? `${hours} h` : "", rest || !hours ? `${rest} min` : ""]
    .filter(Boolean)
    .join(" ");
};

/** One aligned series as its own chart, with coverage and a total. */
function Row({
  title,
  note,
  kind,
  accent,
  format,
  max,
  buckets,
  grain,
  aligned,
  total,
  context,
  unavailable,
  drill,
  aggregate: aggregateNote,
  onOpen,
}: {
  title: string;
  note: string;
  kind: "bar" | "line";
  accent: "periwinkle" | "green" | "amber" | "violet";
  format: (n: number) => string;
  max?: number;
  buckets: Bucket[];
  grain: Grain;
  aligned: Aligned | null;
  total?: string;
  context: WidgetContext;
  unavailable?: string;
  drill?: (point: number) => Drill | null;
  /** Said when the row's points have no records to open. */
  aggregate?: string;
  onOpen: (to: string) => void;
}) {
  const unit = grain === "week" ? "weeks" : "months";
  if (unavailable || aligned?.problem)
    return (
      <Chart
        kind={kind}
        title={title}
        range=""
        format={format}
        series={[]}
        state="unavailable"
        message={unavailable ?? aligned?.problem ?? ""}
      />
    );
  if (!aligned) return <p role="status">Loading {title}…</p>;
  const points: Point[] = buckets.map((b, i) => ({
    label: label(b, grain),
    value: aligned.values[i],
  }));
  return (
    <div data-comparison={title}>
      <Chart
        kind={kind}
        title={title}
        range={`${fullDate(context.period.from)} to ${fullDate(context.period.to)}`}
        format={format}
        max={max}
        series={[{ name: title, accent, points }]}
        drill={drill && ((_, i) => drill(i))}
        onOpen={onOpen}
        aggregateNote={aggregateNote}
        state={aligned.covered === 0 ? "empty" : "ready"}
        message="No data in this period."
      />
      <p className="dash-coverage">
        Data in {aligned.covered} of {buckets.length} {unit}.
        {total ? ` ${total}` : ""} {note}
      </p>
    </div>
  );
}

/**
 * Habit consistency, issues completed, scheduled time, and mood side by side
 * on the same weeks or months. Each keeps its own unit and scale: they are
 * not combined or scored. Plans (scheduled time) and completed work stay in
 * separate rows. Every series is read through the same shared queries as the
 * sections, so a row equals its section for the same period.
 */
export function ComparisonWidget({
  grain,
  context,
}: {
  grain: Grain;
  context: WidgetContext;
}) {
  const { period, project, habit } = context;
  const today = localDate(new Date());
  const zone = deviceZone();
  const buckets = bucketsOf(period, grain);
  const navigate = useNavigate();
  const location = useLocation();
  const onOpen = (to: string) =>
    navigate(to, { state: { from: `${location.pathname}${location.search}` } });

  const progress = useSharedQuery(
    queryKey("progress-analytics", period.from, period.to, project, zone),
    ["issues", "projects", "milestones"],
    () => getProgressAnalytics(period.from, period.to, project, zone),
    analyticsError,
  );
  const schedule = useSharedQuery(
    queryKey("schedule-analytics", period.from, period.to, project, zone),
    ["calendar", "issues", "projects"],
    () => getScheduleAnalytics(period.from, period.to, project, zone),
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
  const mood = useSharedQuery(
    project
      ? null
      : queryKey("checkin-analytics", period.from, period.to, false),
    ["checkins"],
    () => getCheckinAnalytics(period.from, period.to, false),
    checkinError,
  );

  const issues =
    progress.data &&
    align(
      buckets,
      progress.data.trend.buckets.map((b) => ({
        start: b.start,
        end: b.end,
        value: b.completed,
      })),
      today,
      "Issue completions",
    );
  const planned =
    schedule.data &&
    align(
      buckets,
      (schedule.data.days.length > 92
        ? schedule.data.weeks
        : schedule.data.days
      ).map((b) => ({ start: b.start, end: b.end, value: b.busyMinutes })),
      today,
      "Scheduled time",
    );
  const habitRows =
    habits.data &&
    fromEngine(
      buckets,
      (grain === "week" ? habits.data.weeks : habits.data.months).map((b) => ({
        start: b.start,
        end: b.end,
        value: b.percent,
      })),
    );
  const moodRows =
    mood.data &&
    fromEngine(
      buckets,
      (grain === "week" ? mood.data.weeks : mood.data.months).map((b) => ({
        start: b.start,
        end: b.end,
        value: b.mood.average,
      })),
    );

  const errors = [
    progress.error,
    schedule.error,
    habits.error,
    mood.error,
  ].filter(Boolean);
  const hidden =
    "Habits and check-ins are not part of a project, so they are left out while a project is selected.";
  return (
    <section aria-label="Comparison" className="dash-section">
      <h2>Comparison</h2>
      <p>
        Each row has its own unit and scale and shows the same{" "}
        {grain === "week" ? "weeks" : "months"}. They are not combined into a
        score, and they do not show that one causes another.
      </p>
      {errors.length > 0 && (
        <div role="alert">
          <p>{errors[0]}</p>
          <button
            type="button"
            className="action"
            onClick={() => {
              progress.retry();
              schedule.retry();
              habits.retry();
              mood.retry();
            }}
          >
            Retry
          </button>
        </div>
      )}
      <Row
        title="Habit consistency"
        note="Percent of eligible habit days completed."
        kind="line"
        accent="violet"
        format={(n) => `${Math.round(n)}%`}
        max={100}
        buckets={buckets}
        grain={grain}
        aligned={habitRows}
        context={context}
        onOpen={onOpen}
        aggregate={habit ? undefined : NOTES.habits}
        drill={(i) =>
          habitRows?.values[i] != null ? habitDays(buckets[i], habit) : null
        }
        unavailable={project ? hidden : undefined}
        total={
          habits.data?.summary.percent == null
            ? undefined
            : `Whole period: ${Math.round(habits.data.summary.percent)}%.`
        }
      />
      <Row
        title="Issues completed"
        note="Issues marked done, by the day they were completed."
        kind="bar"
        accent="periwinkle"
        format={(n) => `${n} ${n === 1 ? "issue" : "issues"}`}
        buckets={buckets}
        grain={grain}
        aligned={issues}
        context={context}
        onOpen={onOpen}
        drill={(i) => {
          const value = issues?.values[i];
          return value ? completedIssues(buckets[i], value, project) : null;
        }}
        total={issues ? `Total ${issues.total}.` : undefined}
      />
      <Row
        title="Scheduled time"
        note="Planned on the calendar, not time worked."
        kind="bar"
        accent="green"
        format={minutes}
        buckets={buckets}
        grain={grain}
        aligned={planned}
        context={context}
        onOpen={onOpen}
        drill={(i) => (planned?.values[i] ? scheduledTime(buckets[i]) : null)}
        total={
          planned ? `Total ${minutes(planned.total)} scheduled.` : undefined
        }
      />
      <Row
        title="Mood"
        note="Average of the days that rated it, from 1 to 5."
        kind="line"
        accent="amber"
        format={(n) => n.toFixed(1)}
        max={5}
        buckets={buckets}
        grain={grain}
        aligned={moodRows}
        context={context}
        onOpen={onOpen}
        aggregate={NOTES.mood}
        unavailable={project ? hidden : undefined}
      />
    </section>
  );
}
