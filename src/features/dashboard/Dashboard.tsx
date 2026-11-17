import { useEffect, useState } from "react";
import { listProjects, type Project } from "../../database/projects";
import { isTauri } from "../../database/status";
import { GlanceSection } from "./GlanceSection";
import { HabitsSection } from "./HabitsSection";
import { MoodSection } from "./MoodSection";
import { ProgressSection } from "./ProgressSection";
import { ScheduleSection } from "./ScheduleSection";
import "./dashboard.css";

/**
 * The workspace dashboard. One period and one project filter apply to every
 * section, so cards agree with each other and with the screens they link to.
 */
export function Dashboard() {
  const desktop = isTauri();
  const [days, setDays] = useState(30);
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    listProjects().then(
      (list) =>
        live && setProjects(list.filter((item) => item.status !== "archived")),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [desktop]);

  return (
    <section className="dash-view">
      <h1>Dashboards</h1>
      <p>See your progress across the workspace.</p>
      {!desktop && <p>Open the desktop app to see your local progress.</p>}
      {desktop && (
        <>
          <div className="dash-controls">
            <label>
              Project
              <select
                value={project}
                onChange={(event) => setProject(event.target.value)}
              >
                <option value="">All projects</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div role="group" aria-label="Period">
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
            </div>
          </div>
          <GlanceSection project={project || null} days={days} />
          <ProgressSection project={project || null} days={days} />
          <ScheduleSection project={project || null} days={days} />
          <HabitsSection project={project || null} days={days} />
          <MoodSection project={project || null} days={days} />
        </>
      )}
    </section>
  );
}
