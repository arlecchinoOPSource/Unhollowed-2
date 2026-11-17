import { useEffect, useState } from "react";
import {
  checkinError,
  getCheckinAnalytics,
  type CheckinAnalytics,
  type CheckinMetric,
  type CheckinPeriod,
  type CheckinPoint,
} from "../../database/checkins";
import { useDataVersion } from "../../database/dataChanges";
import { fullDate } from "../calendar/monthGrid";
import { localDate } from "../today/dates";

type Key = "mood" | "energy" | "focus";
const METRICS: { key: Key; label: string }[] = [
  { key: "mood", label: "Mood" },
  { key: "energy", label: "Energy" },
  { key: "focus", label: "Focus" },
];

const W = 640;
const H = 150;
const PAD = { left: 40, right: 12, top: 10, bottom: 22 };

const plural = (count: number, one: string) =>
  `${count} ${count === 1 ? one : `${one}s`}`;
const average = (metric: CheckinMetric) =>
  metric.average === null
    ? "No ratings"
    : `${metric.average.toFixed(1)} of 5 (${plural(metric.samples, "day")})`;

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * One metric on a 1 to 5 scale. Only rated days get a mark. A line joins two
 * marks only when they are on consecutive days, so a gap is a visible break,
 * and a missing rating is never drawn as zero or as the scale's floor.
 */
function Chart({
  label,
  points,
  from,
  through,
  pick,
}: {
  label: string;
  points: CheckinPoint[];
  from: string;
  through: string;
  pick: Key;
}) {
  const first = dayNumber(from);
  const span = Math.max(dayNumber(through) - first, 1);
  const x = (date: string) =>
    PAD.left + ((dayNumber(date) - first) / span) * (W - PAD.left - PAD.right);
  const y = (value: number) =>
    PAD.top + ((5 - value) / 4) * (H - PAD.top - PAD.bottom);
  const rated = points.filter((p) => p[pick] !== null);
  const runs: CheckinPoint[][] = [];
  for (const point of rated) {
    const run = runs[runs.length - 1];
    if (
      run &&
      dayNumber(point.date) - dayNumber(run[run.length - 1].date) === 1
    )
      run.push(point);
    else runs.push([point]);
  }
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      className="mood-chart"
      aria-label={`${label} by day, scale 1 to 5, ${fullDate(from)} to ${fullDate(through)}. ${plural(rated.length, "day")} rated; days without a rating are gaps. A data table follows.`}
    >
      <g className="mood-axes" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 6}>
          {fullDate(from)}
        </text>
        <text x={W - PAD.right} y={H - 6} textAnchor="end">
          {fullDate(through)}
        </text>
      </g>
      {runs
        .filter((run) => run.length > 1)
        .map((run) => (
          <polyline
            key={run[0].date}
            className="mood-line"
            points={run.map((p) => `${x(p.date)},${y(p[pick]!)}`).join(" ")}
          />
        ))}
      {rated.map((point) => (
        <circle
          key={point.date}
          className="mood-dot"
          cx={x(point.date)}
          cy={y(point[pick]!)}
          r={rated.length > 60 ? 2.5 : 4}
        >
          <title>{`${fullDate(point.date)}: ${point[pick]} of 5`}</title>
        </circle>
      ))}
    </svg>
  );
}

function PeriodTable({
  caption,
  periods,
  compare,
}: {
  caption: string;
  periods: CheckinPeriod[];
  compare: boolean;
}) {
  return (
    <table className="mood-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          {METRICS.map(({ key, label }) => (
            <th key={key} scope="col">
              {label} average (days rated)
            </th>
          ))}
          {compare && <th scope="col">Habit completion</th>}
        </tr>
      </thead>
      <tbody>
        {periods.map((period) => (
          <tr key={period.start}>
            <th scope="row">
              {period.start === period.end
                ? fullDate(period.start)
                : `${fullDate(period.start)} to ${fullDate(period.end)}`}
            </th>
            {METRICS.map(({ key }) => (
              <td key={key}>{average(period[key])}</td>
            ))}
            {compare && (
              <td>
                {period.habits === null || period.habits.percent === null
                  ? "No eligible days"
                  : `${Math.round(period.habits.percent)}% (${period.habits.completed} of ${period.habits.eligible})`}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Trends in recorded check-ins. Every average comes from the days that rated
 * that metric, with its day count beside it; gaps stay gaps. Habit
 * consistency can sit beside the weeks and months, with no claim that either
 * affects the other. The numbers are the engine's (docs/DATA_MODEL.md).
 */
export function MoodTrends({ reload }: { reload: number }) {
  const today = localDate(new Date());
  const [days, setDays] = useState(30);
  const [compare, setCompare] = useState(false);
  const [data, setData] = useState<CheckinAnalytics | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const changes = useDataVersion("checkins", "habits");

  useEffect(() => {
    let live = true;
    getCheckinAnalytics(localDate(new Date(), 1 - days), today, compare)
      .then((result) => {
        if (!live) return;
        setData(result);
        setError("");
      })
      .catch((cause) => {
        if (!live) return;
        setData(null);
        setError(checkinError(cause));
      });
    return () => {
      live = false;
    };
  }, [days, compare, today, reload, retry, changes]);

  return (
    <section aria-labelledby="mood-trends-title" className="mood-trends">
      <h2 id="mood-trends-title">Trends</h2>
      <div className="mood-actions" role="group" aria-label="Period">
        {[30, 90, 365].map((option) => (
          <button
            key={option}
            type="button"
            className="action"
            aria-pressed={days === option}
            onClick={() => setDays(option)}
          >
            Last {option} days
          </button>
        ))}
        <label className="mood-choice">
          <input
            type="checkbox"
            checked={compare}
            onChange={(event) => setCompare(event.target.checked)}
          />
          <span>Show habit completion beside weeks and months</span>
        </label>
      </div>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="action"
            onClick={() => setRetry((count) => count + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {!data && !error && <p>Loading trends…</p>}
      {data && data.daysRecorded === 0 && (
        <p>
          No check-ins between {fullDate(data.from)} and{" "}
          {fullDate(data.through)}. Trends appear after you record some.
        </p>
      )}
      {data && data.daysRecorded > 0 && (
        <>
          <p>
            {plural(data.daysRecorded, "day")} with a check-in out of{" "}
            {data.daysInPeriod}, {fullDate(data.from)} to{" "}
            {fullDate(data.through)}. Each average uses only the days that rated
            that item, and days without a rating are gaps.
          </p>
          <dl className="mood-tiles">
            {METRICS.map(({ key, label }) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{average(data[key])}</dd>
              </div>
            ))}
          </dl>
          {METRICS.map(({ key, label }) => (
            <div key={key}>
              <h3>{label} by day</h3>
              <Chart
                label={label}
                points={data.points}
                from={data.from}
                through={data.through}
                pick={key}
              />
              <details className="mood-details">
                <summary>Data table: {label} by day</summary>
                <table className="mood-table">
                  <caption className="visually-hidden">{label} by day</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.points
                      .filter((point) => point[key] !== null)
                      .map((point) => (
                        <tr key={point.date}>
                          <th scope="row">{fullDate(point.date)}</th>
                          <td>{point[key]} of 5</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </details>
            </div>
          ))}
          <PeriodTable
            caption="Weekly averages (Monday to Sunday)"
            periods={data.weeks}
            compare={compare}
          />
          <PeriodTable
            caption="Monthly averages"
            periods={data.months}
            compare={compare}
          />
          {compare && (
            <p className="mood-hint">
              Habit completion is shown beside the same weeks and months. It
              does not show that one affects the other.
            </p>
          )}
        </>
      )}
    </section>
  );
}
