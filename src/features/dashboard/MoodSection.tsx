import type { Period } from "./controls";
import { queryKey, useSharedQuery } from "../../database/sharedQuery";
import { Link } from "react-router";
import {
  checkinError,
  getCheckinAnalytics,
  type CheckinMetric,
} from "../../database/checkins";
import { fullDate } from "../calendar/monthGrid";

const SOURCES = ["checkins"] as const;

const metric = (m: CheckinMetric) =>
  m.average === null
    ? "No ratings"
    : `${m.average.toFixed(1)} of 5 (${m.samples} ${m.samples === 1 ? "day" : "days"})`;

/**
 * Optional mood, energy, and focus averages. Shown only where they apply:
 * not under a project filter, and not when the period has no check-ins, so a
 * dashboard never nags for data the user chose not to record. A failed read
 * is the one case that shows the section, with a retry.
 */
export function MoodSection({
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
    project
      ? null
      : queryKey("checkin-analytics", period.from, period.to, false),
    SOURCES,
    () => getCheckinAnalytics(period.from, period.to, false),
    checkinError,
  );

  if (project) return null;
  if (!error && (!data || data.daysRecorded === 0)) return null;
  return (
    <section aria-labelledby="dash-mood-title" className="dash-section">
      <div className="dash-head">
        <h2 id="dash-mood-title">Mood, energy, and focus</h2>
        <Link to="/mood">Open check-ins</Link>
      </div>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="action" onClick={() => reload()}>
            Retry
          </button>
        </div>
      )}
      {data && data.daysRecorded > 0 && (
        <>
          <p>
            {data.daysRecorded} of {data.daysInPeriod} days have a check-in,{" "}
            {fullDate(data.from)} to {fullDate(data.through)}. Each average uses
            only the days that rated it.
          </p>
          <dl className="dash-tiles">
            <div>
              <dt>Mood</dt>
              <dd>{metric(data.mood)}</dd>
            </div>
            <div>
              <dt>Energy</dt>
              <dd>{metric(data.energy)}</dd>
            </div>
            <div>
              <dt>Focus</dt>
              <dd>{metric(data.focus)}</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}
