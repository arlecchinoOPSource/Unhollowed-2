import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import {
  goalError,
  listProjectGoals,
  saveProjectMission,
  saveProjectObjective,
  type Mission,
  type Objective,
  type Rollup,
} from "../../database/goals";
import { issueKey, listIssues } from "../../database/issues";
import { isTauri } from "../../database/status";
import "../projects/projects.css";

type Edit =
  | { kind: "mission"; record?: Mission }
  | { kind: "objective"; record?: Objective };

async function load(projectId: string) {
  const [goals, issues] = await Promise.all([
    listProjectGoals(projectId),
    listIssues(projectId),
  ]);
  return { ...goals, issues };
}

export function ProjectGoalsPage() {
  const { id } = useParams();
  return id ? <Goals key={id} projectId={id} /> : null;
}

function Goals({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof load>>>();
  const [editing, setEditing] = useState<Edit>();
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    load(projectId).then(
      (data) => {
        if (current) setData(data);
      },
      (cause) => {
        if (current) setError(goalError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [projectId, refresh]);

  async function save(event: FormEvent<HTMLFormElement>, edit: Edit) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    const input = {
      title: String(form.get("title")),
      description: String(form.get("description")),
    };
    setError("");
    setSaving(true);
    try {
      if (edit.kind === "mission") {
        await saveProjectMission(projectId, edit.record?.id ?? null, input);
      } else {
        await saveProjectObjective(projectId, edit.record?.id ?? null, {
          ...input,
          missionId: String(form.get("missionId")) || null,
          issueIds: form.getAll("issueId").map(String),
        });
      }
      setEditing(undefined);
      setData(undefined);
      setRefresh((n) => n + 1);
    } catch (cause) {
      setError(goalError(cause));
    } finally {
      setSaving(false);
    }
  }

  const kind = editing?.kind;
  return (
    <section className="projects-view">
      <Link className="project-back" to={`/projects/${projectId}`}>
        Back to project
      </Link>
      <h1>Missions &amp; objectives</h1>
      <p>
        Missions describe broad goals. Objectives define measurable outcomes.
        Milestones mark checkpoints.
      </p>
      {!isTauri() && <p>Open the desktop app to manage project goals.</p>}
      {!data && isTauri() && !error && (
        <p role="status">Loading project goals…</p>
      )}
      {data && (
        <>
          <div className="project-filters">
            <button
              className="action"
              disabled={Boolean(editing)}
              onClick={() => setEditing({ kind: "mission" })}
            >
              New mission
            </button>
            <button
              className="action"
              disabled={Boolean(editing)}
              onClick={() => setEditing({ kind: "objective" })}
            >
              New objective
            </button>
          </div>
          {editing && (
            <form
              className="project-card"
              onSubmit={(event) => void save(event, editing)}
            >
              <h2>
                {editing.record ? "Edit" : "New"} {kind}
              </h2>
              <fieldset disabled={saving} className="goal-fields">
                <label>
                  Title
                  <input
                    name="title"
                    maxLength={200}
                    required
                    defaultValue={editing.record?.title}
                  />
                </label>
                <label>
                  {kind === "objective" ? "Measurable outcome" : "Description"}
                  <textarea
                    name="description"
                    rows={3}
                    maxLength={5000}
                    defaultValue={editing.record?.description}
                  />
                </label>
                {editing.kind === "objective" && (
                  <>
                    <label>
                      Mission
                      <select
                        name="missionId"
                        defaultValue={editing.record?.missionId ?? ""}
                      >
                        <option value="">No mission</option>
                        {data.missions.map((mission) => (
                          <option value={mission.id} key={mission.id}>
                            {mission.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <fieldset className="goal-issue-list">
                      <legend>Project issues</legend>
                      {data.issues.length === 0 && (
                        <p>No issues in this project yet.</p>
                      )}
                      {data.issues.map((issue) => (
                        <label key={issue.id}>
                          <input
                            type="checkbox"
                            name="issueId"
                            value={issue.id}
                            defaultChecked={data.links.some(
                              ([objective, linkedIssue]) =>
                                objective === editing.record?.id &&
                                linkedIssue === issue.id,
                            )}
                          />
                          {issueKey(issue)} {issue.title}
                        </label>
                      ))}
                    </fieldset>
                  </>
                )}
              </fieldset>
              <div className="project-actions">
                <button
                  type="button"
                  className="project-secondary"
                  disabled={saving}
                  onClick={() => {
                    setEditing(undefined);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button className="action" disabled={saving}>
                  {saving ? "Saving…" : `Save ${kind}`}
                </button>
              </div>
            </form>
          )}
          <h2>Missions</h2>
          {data.missions.length === 0 && <p>No missions yet.</p>}
          <ul className="project-grid">
            {data.missions.map((mission) => (
              <li className="project-card" key={mission.id}>
                <h3>{mission.title}</h3>
                <p>{mission.description}</p>
                <RollupSummary title={mission.title} rollup={mission} />
                <button
                  className="project-secondary"
                  disabled={Boolean(editing)}
                  onClick={() =>
                    setEditing({ kind: "mission", record: mission })
                  }
                >
                  Edit mission
                </button>
              </li>
            ))}
          </ul>
          <h2>Objectives</h2>
          {data.objectives.length === 0 && <p>No objectives yet.</p>}
          <ul className="project-grid">
            {data.objectives.map((objective) => (
              <li className="project-card" key={objective.id}>
                <h3>{objective.title}</h3>
                <p>{objective.description}</p>
                {objective.missionId && (
                  <p>
                    Mission ·{" "}
                    {
                      data.missions.find(
                        (mission) => mission.id === objective.missionId,
                      )?.title
                    }
                  </p>
                )}
                <RollupSummary title={objective.title} rollup={objective} />
                <ul>
                  {data.issues
                    .filter((issue) =>
                      data.links.some(
                        ([goal, id]) =>
                          goal === objective.id && id === issue.id,
                      ),
                    )
                    .map((issue) => (
                      <li key={issue.id}>
                        <Link
                          to={`/issues/${issue.id}`}
                          state={{
                            from: `/projects/${projectId}/goals`,
                          }}
                        >
                          {issueKey(issue)} {issue.title}
                        </Link>
                      </li>
                    ))}
                </ul>
                <button
                  className="project-secondary"
                  disabled={Boolean(editing)}
                  onClick={() =>
                    setEditing({ kind: "objective", record: objective })
                  }
                >
                  Edit objective
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {error && !data && (
        <button
          className="action"
          onClick={() => {
            setError("");
            setRefresh((n) => n + 1);
          }}
        >
          Retry
        </button>
      )}
    </section>
  );
}

/**
 * Progress for an objective or mission: done out of all counted issues,
 * with blocked and canceled work called out. Empty groups show no bar.
 */
function RollupSummary({ title, rollup }: { title: string; rollup: Rollup }) {
  const notes = [
    rollup.blocked > 0 && `${rollup.blocked} blocked`,
    rollup.canceled > 0 && `${rollup.canceled} canceled, not counted`,
  ].filter(Boolean);
  return (
    <>
      <p>
        {rollup.total
          ? `${rollup.completed} of ${rollup.total} issues done (${Math.round(
              (rollup.completed / rollup.total) * 100,
            )}%)`
          : "No issues count toward progress yet."}
        {notes.length > 0 && ` · ${notes.join(" · ")}`}
      </p>
      {rollup.total > 0 && (
        <progress
          aria-label={`Progress for ${title}`}
          max={rollup.total}
          value={rollup.completed}
        />
      )}
    </>
  );
}
