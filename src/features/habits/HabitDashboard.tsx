import { useEffect, useState } from "react";
import {
  getHabitStatistics,
  habitError,
  type HabitBucket,
  type HabitStatistics,
} from "../../database/habits";
import { useDataVersion } from "../../database/dataChanges";
import { fullDate } from "../calendar/monthGrid";
import { localDate } from "../today/dates";

const W = 640;
const H = 150;
const PAD = { left: 40, right: 8, top: 8, bottom: 22 };

const plural = (count: number, one: string) =>
  `${count} ${count === 1 ? one : `${one}s`}`;
const pct = (value: number | null) =>
  value === null ? "No eligible days" : `${Math.round(value)}%`;

function shift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

function bucketLabel(bucket: HabitBucket): string {
  const range =
    bucket.start === bucket.end
      ? fullDate(bucket.start)
      : `${fullDate(bucket.start)} to ${fullDate(bucket.end)}`;
  return `${range}: ${
    bucket.percent === null
      ? "no eligible days"
      : `${Math.round(bucket.percent)}%, ${bucket.completed} of ${bucket.eligible} days`
  }`;
}

/** Y axis shared by both charts: 0 to 100 percent. */
function Axes({ first, last }: { first: string; last: string }) {
  const y = (value: number) =>
    PAD.top + (1 - value / 100) * (H - PAD.top - PAD.bottom);
  return (
    <g className="habit-axes" aria-hidden="true">
      {[0, 50, 100].map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} />
          <text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">
            {tick}%
          </text>
        </g>
      ))}
      <text x={PAD.left} y={H - 6}>
        {first}
      </text>
      <text x={W - PAD.right} y={H - 6} textAnchor="end">
        {last}
      </text>
    </g>
  );
}

/**
 * Completion percent per bucket. A bucket with no eligible days is drawn as a
 * dashed empty slot, never as a zero-height bar, so "no data" and "0%" differ
 * by shape and label, not only color.
 */
export function Bars({
  buckets,
  name,
}: {
  buckets: HabitBucket[];
  name: string;
}) {
  const inner = W - PAD.left - PAD.right;
  const slot = inner / Math.max(buckets.length, 1);
  const width = Math.max(Math.min(slot - 2, 40), 1);
  const base = H - PAD.bottom;
  const scale = (base - PAD.top) / 100;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${name}: completion rate per period. A data table follows.`}
      className="habit-chart"
    >
      <Axes
        first={buckets[0] ? fullDate(buckets[0].start) : ""}
        last={buckets.length ? fullDate(buckets[buckets.length - 1].end) : ""}
      />
      {buckets.map((bucket, index) => {
        const x = PAD.left + index * slot + (slot - width) / 2;
        return bucket.percent === null ? (
          <rect
            key={bucket.start}
            className="habit-missing"
            x={x}
            y={base - 16}
            width={width}
            height={16}
          >
            <title>{bucketLabel(bucket)}</title>
          </rect>
        ) : (
          <rect
            key={bucket.start}
            className="habit-bar"
            x={x}
            y={base - Math.max(bucket.percent * scale, 2)}
            width={width}
            height={Math.max(bucket.percent * scale, 2)}
            rx={Math.min(4, width / 2)}
          >
            <title>{bucketLabel(bucket)}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** Daily completion curve. Days with no eligible days break the line. */
function Curve({ buckets }: { buckets: HabitBucket[] }) {
  const inner = W - PAD.left - PAD.right;
  const step = inner / Math.max(buckets.length - 1, 1);
  const base = H - PAD.bottom;
  const scale = (base - PAD.top) / 100;
  const runs: string[][] = [[]];
  buckets.forEach((bucket, index) => {
    if (bucket.percent === null) {
      if (runs[runs.length - 1].length) runs.push([]);
      return;
    }
    runs[runs.length - 1].push(
      `${PAD.left + index * step},${base - bucket.percent * scale}`,
    );
  });
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Daily completion rate. A data table follows."
      className="habit-chart"
    >
      <Axes
        first={buckets[0] ? fullDate(buckets[0].start) : ""}
        last={buckets.length ? fullDate(buckets[buckets.length - 1].end) : ""}
      />
      {runs.map(
        (points) =>
          points.length > 0 && (
            <polyline
              key={points[0]}
              className="habit-line"
              points={points.join(" ")}
            />
          ),
      )}
      {buckets.map((bucket, index) =>
        bucket.percent === null ? (
          <line
            key={bucket.start}
            className="habit-missing-tick"
            x1={PAD.left + index * step}
            x2={PAD.left + index * step}
            y1={base - 6}
            y2={base}
          >
            <title>{bucketLabel(bucket)}</title>
          </line>
        ) : (
          <circle
            key={bucket.start}
            className="habit-dot"
            cx={PAD.left + index * step}
            cy={base - bucket.percent * scale}
            r={buckets.length > 60 ? 1.5 : 4}
          >
            <title>{bucketLabel(bucket)}</title>
          </circle>
        ),
      )}
    </svg>
  );
}

export function Table({
  caption,
  buckets,
}: {
  caption: string;
  buckets: HabitBucket[];
}) {
  return (
    <details className="habit-table">
      <summary>Data table: {caption}</summary>
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Completed</th>
            <th scope="col">Eligible</th>
            <th scope="col">Rate</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.start}>
              <th scope="row">
                {bucket.start === bucket.end
                  ? fullDate(bucket.start)
                  : `${fullDate(bucket.start)} to ${fullDate(bucket.end)}`}
              </th>
              <td>{bucket.completed}</td>
              <td>{bucket.eligible}</td>
              <td>{pct(bucket.percent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * Trends from the statistics engine (docs/HABITS.md, "Statistics"). Every
 * number is the engine's; nothing is recomputed here.
 */
export function HabitDashboard({ reload }: { reload: number }) {
  const today = localDate(new Date());
  const [from, setFrom] = useState(shift(today, -29));
  const [to, setTo] = useState(today);
  const [stats, setStats] = useState<HabitStatistics | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const changes = useDataVersion("habits");

  useEffect(() => {
    let live = true;
    getHabitStatistics(from, to)
      .then((result) => {
        if (!live) return;
        setStats(result);
        setError("");
      })
      .catch((cause) => {
        if (!live) return;
        // Never leave the last good numbers on screen beside an error.
        setStats(null);
        setError(habitError(cause));
      });
    return () => {
      live = false;
    };
  }, [from, to, reload, retry, changes]);

  const preset = (days: number) => {
    setFrom(shift(today, 1 - days));
    setTo(today);
  };
  const monthly = stats ? stats.days.length === 0 : false;

  return (
    <section
      className="habit-dashboard"
      aria-labelledby="habit-dashboard-title"
    >
      <h2 id="habit-dashboard-title">Habit trends</h2>
      <div className="habit-range" role="group" aria-label="Date range">
        <label>
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(event) =>
              event.target.value && setFrom(event.target.value)
            }
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(event) =>
              event.target.value && setTo(event.target.value)
            }
          />
        </label>
        {[7, 30, 90, 365].map((days) => (
          <button
            key={days}
            type="button"
            className="action"
            onClick={() => preset(days)}
          >
            Last {days} days
          </button>
        ))}
      </div>

      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="action"
            onClick={() => setRetry((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {!stats && !error && <p>Loading trends…</p>}

      {stats && stats.habits.length === 0 && (
        <p>No habits yet. Add a habit to see trends.</p>
      )}

      {stats && stats.habits.length > 0 && (
        <>
          <p>
            {fullDate(stats.from)} to {fullDate(stats.through)}. Future days are
            not counted.
          </p>
          <dl className="habit-tiles">
            <div>
              <dt>Completion rate</dt>
              <dd>{pct(stats.summary.percent)}</dd>
            </div>
            <div>
              <dt>Days completed</dt>
              <dd>
                {stats.summary.completed} of {stats.summary.eligible} eligible
              </dd>
            </div>
            <div>
              <dt>Practice streak (any habit)</dt>
              <dd>
                {plural(stats.practice.current, "day")} now,{" "}
                {plural(stats.practice.longest, "day")} longest
              </dd>
            </div>
          </dl>

          {stats.summary.eligible === 0 && (
            <p>
              No habit was eligible in this period, so there is no rate yet.
            </p>
          )}

          {!monthly && (
            <>
              <h3>Daily completion</h3>
              <Curve buckets={stats.days} />
              <Table caption="Daily completion" buckets={stats.days} />
            </>
          )}
          <h3>Weekly completion (Monday to Sunday)</h3>
          <Bars buckets={stats.weeks} name="Weekly completion" />
          <Table caption="Weekly completion" buckets={stats.weeks} />
          <h3>Monthly completion</h3>
          <Bars buckets={stats.months} name="Monthly completion" />
          <Table caption="Monthly completion" buckets={stats.months} />
          <p className="habit-legend">
            Solid bars and dots are completion rates. A dashed outline or a
            small tick marks a period with no eligible days: no data, not 0%.
          </p>

          <h3>Each habit</h3>
          <table className="habit-each">
            <thead>
              <tr>
                <th scope="col">Habit</th>
                <th scope="col">Rate</th>
                <th scope="col">Completed</th>
                <th scope="col">Current streak</th>
                <th scope="col">Longest streak</th>
              </tr>
            </thead>
            <tbody>
              {stats.habits.map((habit) => (
                <tr key={habit.habitId}>
                  <th scope="row">
                    {habit.name}
                    {habit.archived ? " (archived)" : ""}
                  </th>
                  <td>
                    {habit.percent === null ? (
                      "No eligible days"
                    ) : (
                      <>
                        <meter
                          min={0}
                          max={100}
                          value={habit.percent}
                          aria-hidden="true"
                        />{" "}
                        {pct(habit.percent)}
                      </>
                    )}
                  </td>
                  <td>
                    {habit.completed} of {habit.eligible}
                  </td>
                  <td>{plural(habit.streaks.current, "day")}</td>
                  <td>{plural(habit.streaks.longest, "day")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
