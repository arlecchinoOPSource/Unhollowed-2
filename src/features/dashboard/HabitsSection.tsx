import type { Period } from "./controls";
import { queryKey, useSharedQuery } from "../../database/sharedQuery";
import { Link } from "react-router";
import {
  getHabitStatistics,
  habitError,
} from "../../database/habits";
import { fullDate } from "../calendar/monthGrid";
import { Bars, Table } from "../habits/HabitDashboard";
import "../habits/habits.css";

const SOURCES = ["habits"] as const;

const plural = (count: number, one: string) =>
  `${count} ${count === 1 ? one : `${one}s`}`;

/**
 * Habit completion for the shared period, from the same statistics engine as
 * the habits page. Habits belong to no project, so under a project filter
 * the section says it does not apply instead of showing unfiltered numbers.
 */
export function HabitsSection({
  project,
  habit,
  period,
}: {
  project: string | null;
  habit: string | null;
  period: Period;
}) {
  const {
    data,
    error,
    retry: reload,
  } = useSharedQuery(
    project
      ? null
      : queryKey("habit-statistics", period.from, period.to, habit),
    SOURCES,
    () => getHabitStatistics(period.from, period.to, habit ? [habit] : null),
    habitError,
  );

  return (
    <section aria-labelledby="dash-habits-title" className="dash-section">
      <div className="dash-head">
        <h2 id="dash-habits-title">Habits</h2>
        <Link to="/habits">Open habits</Link>
      </div>
      {project && (
        <p>
          Habits are not part of a project, so they are left out while a project
          is selected.
        </p>
      )}
      {!project && error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="action" onClick={() => reload()}>
            Retry
          </button>
        </div>
      )}
      {!project && !data && !error && <p>Loading habits…</p>}
      {!project && data && data.habits.length === 0 && (
        <p>No habits yet. Add a habit to see its progress here.</p>
      )}
      {!project && data && data.habits.length > 0 && (
        <>
          <p>
            {fullDate(data.from)} to {fullDate(data.through)}. Future days are
            not counted.
          </p>
          <dl className="dash-tiles">
            <div>
              <dt>Completion rate</dt>
              <dd>
                {data.summary.percent === null
                  ? "No eligible days"
                  : `${Math.round(data.summary.percent)}%`}
              </dd>
            </div>
            <div>
              <dt>Days completed</dt>
              <dd>
                {data.summary.completed} of {data.summary.eligible} eligible
              </dd>
            </div>
            <div>
              <dt>Practice streak (any habit)</dt>
              <dd>
                {plural(data.practice.current, "day")} now,{" "}
                {plural(data.practice.longest, "day")} longest
              </dd>
            </div>
          </dl>
          <h3>Weekly completion (Monday to Sunday)</h3>
          <Bars buckets={data.weeks} name="Weekly habit completion" />
          <Table caption="Weekly habit completion" buckets={data.weeks} />
        </>
      )}
    </section>
  );
}
