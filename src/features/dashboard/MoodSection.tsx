import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  checkinError,
  getCheckinAnalytics,
  type CheckinAnalytics,
  type CheckinMetric,
} from "../../database/checkins";
import { useDataVersion } from "../../database/dataChanges";
import { fullDate } from "../calendar/monthGrid";
import { localDate } from "../today/dates";

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
  days,
}: {
  project: string | null;
  days: number;
}) {
  const today = localDate(new Date());
  const [data, setData] = useState<CheckinAnalytics | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const changes = useDataVersion("checkins");

  useEffect(() => {
    if (project) return;
    let live = true;
    getCheckinAnalytics(localDate(new Date(), 1 - days), today, false)
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
  }, [days, project, today, retry, changes]);

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
          <button
            type="button"
            className="action"
            onClick={() => setRetry((n) => n + 1)}
          >
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
