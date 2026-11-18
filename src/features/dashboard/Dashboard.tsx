import { useEffect, useMemo, useState } from "react";
import { listHabits, type Habit } from "../../database/habits";
import { listProjects, type Project } from "../../database/projects";
import { isTauri } from "../../database/status";
import { fullDate } from "../calendar/monthGrid";
import { localDate } from "../today/dates";
import {
  daysIn,
  defaults,
  periodProblem,
  presets,
  readPreferences,
  resolvePeriod,
  sections,
  writePreferences,
  type Period,
  type Preferences,
  type SectionKey,
} from "./controls";
import { WidgetHost } from "./WidgetHost";
import { defaultLayout } from "./widgets";
import "./dashboard.css";

/**
 * The workspace dashboard. One period and one project or habit filter apply
 * to every section that they make sense for, so cards agree with each other
 * and with the screens they link to. The period and the visible sections are
 * remembered on this device; the filters are not, because they name records
 * that may be gone by the next visit.
 */
export function Dashboard() {
  const desktop = isTauri();
  const today = localDate(new Date());
  const [prefs, setPrefs] = useState<Preferences>(() => readPreferences(today));
  const [project, setProject] = useState("");
  const [habit, setHabit] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);

  useEffect(() => writePreferences(prefs), [prefs]);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    listProjects().then(
      (list) =>
        live && setProjects(list.filter((item) => item.status !== "archived")),
      () => undefined,
    );
    listHabits().then(
      (list) => live && setHabits(list.filter((item) => !item.archivedOn)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [desktop]);

  const period: Period = useMemo(
    () => resolvePeriod(prefs, today),
    [prefs, today],
  );
  const problem =
    prefs.preset === "custom" ? periodProblem(prefs.custom) : null;
  const filtered = project !== "" || habit !== "";
  const changed = prefs.preset !== defaults(today).preset;
  const shown = (key: SectionKey) => !prefs.hidden.includes(key);
  const scope = project || null;

  return (
    <section className="dash-view">
      <h1>Dashboards</h1>
      <p>See your progress across the workspace.</p>
      {!desktop && <p>Open the desktop app to see your local progress.</p>}
      {desktop && (
        <>
          <div className="dash-controls">
            <div role="group" aria-label="Period">
              {presets.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className="action"
                  aria-pressed={prefs.preset === value}
                  onClick={() => setPrefs({ ...prefs, preset: value })}
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              Project
              <select
                value={project}
                onChange={(event) => {
                  setProject(event.target.value);
                  if (event.target.value) setHabit("");
                }}
              >
                <option value="">All projects</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Habit
              <select
                value={habit}
                disabled={project !== ""}
                onChange={(event) => setHabit(event.target.value)}
              >
                <option value="">All habits</option>
                {habits.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {(filtered || changed) && (
              <button
                type="button"
                className="action"
                onClick={() => {
                  setProject("");
                  setHabit("");
                  setPrefs({ ...prefs, preset: defaults(today).preset });
                }}
              >
                Clear filters
              </button>
            )}
          </div>
          {prefs.preset === "custom" && (
            <div
              className="dash-controls"
              role="group"
              aria-label="Custom dates"
            >
              {(["from", "to"] as const).map((edge) => (
                <label key={edge}>
                  {edge === "from" ? "From" : "To"}
                  <input
                    type="date"
                    value={prefs.custom[edge]}
                    min="1900-01-01"
                    onChange={(event) =>
                      setPrefs({
                        ...prefs,
                        custom: { ...prefs.custom, [edge]: event.target.value },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {problem && (
            <p role="alert">
              {problem} Showing the last 30 days until the dates are valid.
            </p>
          )}
          <p role="status" className="dash-period">
            Showing {fullDate(period.from)} to {fullDate(period.to)} (
            {daysIn(period)} {daysIn(period) === 1 ? "day" : "days"}
            ), through today at most.
            {project ? " Filtered to one project." : ""}
            {habit ? " Habits filtered to one habit." : ""}
          </p>
          <details className="dash-details">
            <summary>Sections</summary>
            <div role="group" aria-label="Visible sections">
              {sections.map(({ key, label }) => (
                <label key={key} className="dash-check">
                  <input
                    type="checkbox"
                    checked={shown(key)}
                    onChange={(event) =>
                      setPrefs({
                        ...prefs,
                        hidden: event.target.checked
                          ? prefs.hidden.filter((item) => item !== key)
                          : [...prefs.hidden, key],
                      })
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
              {prefs.hidden.length > 0 && (
                <button
                  type="button"
                  className="action"
                  onClick={() => setPrefs({ ...prefs, hidden: [] })}
                >
                  Show all sections
                </button>
              )}
            </div>
          </details>
          {prefs.hidden.length === sections.length && (
            <p>All sections are hidden. Turn some on under Sections.</p>
          )}
          {defaultLayout
            .filter(({ id }) => shown(id as SectionKey))
            .map((instance) => (
              <WidgetHost
                key={instance.id}
                instance={instance}
                context={{ project: scope, habit: habit || null, period }}
              />
            ))}
        </>
      )}
    </section>
  );
}
