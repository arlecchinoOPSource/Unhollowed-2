import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  analyticsError,
  getScheduleAnalytics,
  type ScheduleAnalytics,
  type ScheduleBucket,
  type UpcomingItem,
} from "../../database/analytics";
import { useDataVersion } from "../../database/dataChanges";
import { deviceZone } from "../../database/events";
import { fullDate } from "../calendar/monthGrid";
import { localDate } from "../today/dates";

const W = 640;
const H = 150;
const PAD = { left: 40, right: 8, top: 10, bottom: 22 };

const plural = (count: number, one: string) =>
  `${count} ${count === 1 ? one : `${one}s`}`;

/** "1 h 30 min", never a decimal that could be mistaken for actual hours. */
function span(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} h` : "", rest || !hours ? `${rest} min` : ""]
    .filter(Boolean)
    .join(" ");
}

const kinds: Record<UpcomingItem["kind"], string> = {
  event: "Event",
  work_block: "Planned work session",
  deadline: "Due date",
};

function Chart({ buckets, unit }: { buckets: ScheduleBucket[]; unit: string }) {
  const peak = Math.max(60, ...buckets.map((b) => b.busyMinutes));
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
      aria-label={`Scheduled time per ${unit}, ${buckets[0] ? fullDate(buckets[0].start) : ""} to ${buckets.length ? fullDate(buckets[buckets.length - 1].end) : ""}, highest ${span(peak)}. A data table follows.`}
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
              {span(tick)}
            </text>
          </g>
        ))}
      </g>
      {buckets.map((bucket, index) => (
        <rect
          key={bucket.start}
          className={bucket.busyMinutes === 0 ? "dash-zero" : "dash-bar"}
          x={PAD.left + index * slot + (slot - width) / 2}
          y={base - Math.max(bucket.busyMinutes * scale, 2)}
          width={width}
          height={Math.max(bucket.busyMinutes * scale, 2)}
        >
          <title>{`${fullDate(bucket.start)}${bucket.start === bucket.end ? "" : ` to ${fullDate(bucket.end)}`}: ${span(bucket.busyMinutes)} scheduled`}</title>
        </rect>
      ))}
    </svg>
  );
}

/**
 * Scheduled activity from `get_schedule_analytics`: events, planned work
 * sessions, and due dates, kept apart and labeled. Hours are scheduled, never
 * time actually worked. docs/ANALYTICS.md, "Schedule".
 */
export function ScheduleSection({
  project,
  days,
}: {
  project: string | null;
  days: number;
}) {
  const today = localDate(new Date());
  const [data, setData] = useState<ScheduleAnalytics | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const changes = useDataVersion("calendar", "issues", "projects");

  useEffect(() => {
    let live = true;
    getScheduleAnalytics(
      localDate(new Date(), 1 - days),
      today,
      project,
      deviceZone(),
    )
      .then((result) => {
        if (!live) return;
        setData(result);
        setError("");
      })
      .catch((cause) => {
        if (!live) return;
        setData(null);
        setError(analyticsError(cause));
      });
    return () => {
      live = false;
    };
  }, [days, project, today, retry, changes]);

  const buckets = data && (data.days.length > 92 ? data.weeks : data.days);
  const t = data?.totals;
  return (
    <section aria-labelledby="schedule-title" className="dash-section">
      <div className="dash-head">
        <h2 id="schedule-title">Schedule</h2>
        <Link to="/calendar">Open calendar</Link>
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
      {!data && !error && <p>Loading schedule…</p>}
      {data && t && (
        <>
          <p>
            {fullDate(data.from)} to {fullDate(data.to)}. These are scheduled
            hours, what the calendar plans, not time actually spent. Events,
            planned work sessions, and due dates are counted separately.
          </p>
          {data.truncated && (
            <p role="note">
              The calendar has more items than it can list for this period, so
              these counts may be low. Choose a shorter period.
            </p>
          )}
          <dl className="dash-tiles">
            <div>
              <dt>Events</dt>
              <dd>
                {t.events} ({t.timedEvents} timed, {t.allDayEvents} all-day),{" "}
                {span(t.eventMinutes)} scheduled
              </dd>
            </div>
            <div>
              <dt>Planned work sessions</dt>
              <dd>
                {t.workBlocks}, {span(t.workBlockMinutes)} scheduled
              </dd>
            </div>
            <div>
              <dt>Open due dates</dt>
              <dd>{t.deadlines}</dd>
            </div>
            <div>
              <dt>Busy time</dt>
              <dd>
                {span(t.busyMinutes)}
                {t.overlapMinutes > 0
                  ? `, ${span(t.overlapMinutes)} of overlap counted once`
                  : ""}
              </dd>
            </div>
          </dl>

          {t.events + t.workBlocks + t.deadlines === 0 ? (
            <p>Nothing is scheduled in this period.</p>
          ) : (
            <>
              <h3>
                Scheduled time by {data.days.length > 92 ? "week" : "day"}
              </h3>
              <Chart
                buckets={buckets!}
                unit={data.days.length > 92 ? "week" : "day"}
              />
              <details className="dash-details">
                <summary>Data table: scheduled time</summary>
                <table className="dash-table">
                  <caption className="visually-hidden">Scheduled time</caption>
                  <thead>
                    <tr>
                      <th scope="col">Period</th>
                      <th scope="col">Events</th>
                      <th scope="col">Work sessions</th>
                      <th scope="col">Busy</th>
                      <th scope="col">Due dates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buckets!.map((bucket) => (
                      <tr key={bucket.start}>
                        <th scope="row">
                          {bucket.start === bucket.end
                            ? fullDate(bucket.start)
                            : `${fullDate(bucket.start)} to ${fullDate(bucket.end)}`}
                        </th>
                        <td>{span(bucket.eventMinutes)}</td>
                        <td>{span(bucket.workBlockMinutes)}</td>
                        <td>{span(bucket.busyMinutes)}</td>
                        <td>{bucket.deadlines}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>

              <h3>By project</h3>
              <table className="dash-table">
                <caption className="visually-hidden">
                  Scheduled time by project
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Events</th>
                    <th scope="col">Planned work sessions</th>
                    <th scope="col">Due dates</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((item) => (
                    <tr key={`${item.kind}-${item.projectId}`}>
                      <th scope="row">{item.name}</th>
                      <td>
                        {item.events}, {span(item.eventMinutes)}
                      </td>
                      <td>
                        {item.workBlocks}, {span(item.workBlockMinutes)}
                      </td>
                      <td>{item.deadlines}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h3>Coming up in the next 7 days</h3>
          {data.upcoming.next.length === 0 ? (
            <p>Nothing scheduled or due in the next 7 days.</p>
          ) : (
            <>
              <p>
                {plural(data.upcoming.events, "event")},{" "}
                {plural(data.upcoming.workBlocks, "planned work session")},{" "}
                {plural(data.upcoming.deadlines, "due date")}.
              </p>
              <ul className="dash-deadlines" aria-label="Coming up">
                {data.upcoming.next.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    <strong>{kinds[item.kind]}</strong>: {item.title},{" "}
                    {item.allDay || item.kind === "deadline"
                      ? fullDate(item.when.slice(0, 10))
                      : `${fullDate(item.when.slice(0, 10))} ${item.when.slice(11)}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
