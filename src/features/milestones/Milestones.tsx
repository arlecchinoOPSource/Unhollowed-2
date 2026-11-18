import { ArrowLeft, Flag } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import {
  closeMilestone,
  createMilestone,
  listMilestones,
  milestoneError,
  milestoneProgress,
  reopenMilestone,
  updateMilestone,
  type Milestone,
  type MilestoneInput,
} from "../../database/milestones";
import { listProjects, type Project } from "../../database/projects";
import { isTauri } from "../../database/status";
import "../labels/labels.css";
import "./milestones.css";

function readInput(form: HTMLFormElement): MilestoneInput {
  const data = new FormData(form);
  return {
    title: String(data.get("title")).trim(),
    description: String(data.get("description") ?? "").trim() || null,
    dueDate: String(data.get("dueDate") ?? "") || null,
  };
}

function MilestoneFields({
  initial,
  titleRef,
}: {
  initial?: Milestone;
  titleRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <>
      <label className="milestone-title-field">
        Milestone title
        <input
          ref={titleRef}
          name="title"
          required
          maxLength={200}
          defaultValue={initial?.title}
        />
      </label>
      <label>
        Due date
        <input
          type="date"
          name="dueDate"
          defaultValue={initial?.dueDate ?? ""}
        />
      </label>
      <label className="milestone-description-field">
        Description (optional)
        <input
          name="description"
          maxLength={5000}
          defaultValue={initial?.description ?? ""}
        />
      </label>
    </>
  );
}

/** Progress in words, plus a bar when issues contribute to it. */
function Progress({ milestone }: { milestone: Milestone }) {
  const progress = milestoneProgress(milestone);
  const contributing = milestone.openCount + milestone.completedCount;
  return (
    <div className="milestone-progress">
      {progress === null ? (
        <p>No issues yet</p>
      ) : (
        <>
          <progress
            max={contributing}
            value={milestone.completedCount}
            aria-label={`Progress for ${milestone.title}`}
          />
          <p>
            {milestone.completedCount} of {contributing} complete (
            {Math.round(progress * 100)}%) · {milestone.openCount} open
          </p>
        </>
      )}
      {milestone.blockedCount > 0 && (
        <p>
          {milestone.blockedCount} of the open{" "}
          {milestone.blockedCount === 1 ? "issue is" : "issues are"} blocked
        </p>
      )}
      {milestone.canceledCount > 0 && (
        <p>
          {milestone.canceledCount} canceled{" "}
          {milestone.canceledCount === 1 ? "issue is" : "issues are"} not
          counted
        </p>
      )}
    </div>
  );
}

/**
 * Workspace and project milestones. `?project=` narrows the list to one
 * project, or to workspace milestones with `workspace`. `?state=closed`
 * shows closed milestones.
 */
export function Milestones() {
  const desktop = isTauri();
  const [params, setParams] = useSearchParams();
  const scope = params.get("project") ?? "";
  const showClosed = params.get("state") === "closed";
  const [milestones, setMilestones] = useState<Milestone[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadError, setLoadError] = useState("");
  const [request, setRequest] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const editTitle = useRef<HTMLInputElement>(null);
  const createTitle = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    Promise.all([listMilestones(), listProjects()]).then(
      ([loaded, loadedProjects]) => {
        if (!current) return;
        setMilestones(loaded);
        setProjects(loadedProjects);
      },
      (cause) => {
        if (current) setLoadError(milestoneError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, request]);

  useEffect(() => {
    if (pendingFocus.current === null) return;
    const target =
      pendingFocus.current === "edit-form"
        ? editTitle.current
        : pendingFocus.current === "create-form"
          ? createTitle.current
          : buttons.current.get(pendingFocus.current);
    pendingFocus.current = null;
    target?.focus();
  });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  function replace(milestone: Milestone) {
    setMilestones((current) => {
      const others = (current ?? []).filter(({ id }) => id !== milestone.id);
      return [...others, milestone];
    });
  }

  async function run(work: () => Promise<void>) {
    if (saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError(milestoneError(cause));
    } finally {
      setSaving(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = readInput(form);
    const project = String(new FormData(form).get("project") ?? "") || null;
    void run(async () => {
      const milestone = await createMilestone(input, project);
      replace(milestone);
      setFormKey((key) => key + 1);
      pendingFocus.current = "create-form";
      setMessage(`Created milestone ${milestone.title}.`);
    });
  }

  function save(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const input = readInput(event.currentTarget);
    void run(async () => {
      const milestone = await updateMilestone(id, input);
      replace(milestone);
      setEditing(null);
      pendingFocus.current = `${id}:edit`;
      setMessage(`Saved milestone ${milestone.title}.`);
    });
  }

  function toggleClosed(milestone: Milestone) {
    void run(async () => {
      const changed = milestone.closed
        ? await reopenMilestone(milestone.id)
        : await closeMilestone(milestone.id);
      replace(changed);
      setMessage(
        changed.closed
          ? `Closed ${changed.title}. Its issues keep the milestone.`
          : `Reopened ${changed.title}.`,
      );
    });
  }

  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const inScope = (milestones ?? []).filter((milestone) =>
    scope === ""
      ? true
      : scope === "workspace"
        ? milestone.projectId === null
        : milestone.projectId === scope,
  );
  const shown = inScope
    .filter((milestone) => milestone.closed === showClosed)
    .sort(
      (a, b) =>
        Number(a.dueDate === null) - Number(b.dueDate === null) ||
        (a.dueDate ?? "").localeCompare(b.dueDate ?? "") ||
        a.title.localeCompare(b.title),
    );
  const openCount = inScope.filter((milestone) => !milestone.closed).length;
  const createProject =
    scope && scope !== "workspace" && projectNames.has(scope) ? scope : "";

  return (
    <section className="labels-view milestones-view">
      <Link className="issue-back" to="/issues">
        <ArrowLeft size={16} aria-hidden="true" /> All issues
      </Link>
      <h1>Milestones</h1>
      {!desktop && <p>Open the desktop app to manage your local milestones.</p>}
      {desktop && (
        <form
          key={formKey}
          aria-label="Create a milestone"
          className="milestone-create"
          onSubmit={create}
        >
          <MilestoneFields titleRef={createTitle} />
          <label>
            Applies to
            <select name="project" defaultValue={createProject}>
              <option value="">Whole workspace</option>
              {projects
                .filter((project) => project.status !== "archived")
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
          </label>
          <button className="action" type="submit" aria-disabled={saving}>
            Create milestone
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>

      <div className="milestone-controls">
        <label>
          Show milestones for
          <select
            value={scope}
            onChange={(event) => setParam("project", event.target.value)}
          >
            <option value="">All projects and workspace</option>
            <option value="workspace">Whole workspace only</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <div className="issue-filters" role="group" aria-label="Show">
          <button
            type="button"
            aria-pressed={!showClosed}
            onClick={() => setParam("state", "")}
          >
            Open
            {milestones && <span className="issue-count">{openCount}</span>}
          </button>
          <button
            type="button"
            aria-pressed={showClosed}
            onClick={() => setParam("state", "closed")}
          >
            Closed
            {milestones && (
              <span className="issue-count">{inScope.length - openCount}</span>
            )}
          </button>
        </div>
      </div>

      {loadError && (
        <div role="alert">
          <p>{loadError}</p>
          <button
            className="action"
            onClick={() => {
              setLoadError("");
              setRequest(request + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {desktop && !loadError && milestones === null && (
        <p>Loading milestones…</p>
      )}
      {milestones?.length === 0 && (
        <div className="issues-empty">
          <Flag size={24} aria-hidden="true" />
          <h2>No milestones yet</h2>
          <p>Create a milestone to plan a checkpoint.</p>
        </div>
      )}
      {milestones && milestones.length > 0 && shown.length === 0 && (
        <p>{showClosed ? "No closed milestones." : "No open milestones."}</p>
      )}
      {shown.length > 0 && (
        <ul
          className="milestone-list"
          aria-label={showClosed ? "Closed milestones" : "Open milestones"}
        >
          {shown.map((milestone) => (
            <li key={milestone.id} className="milestone-card">
              {editing === milestone.id ? (
                <form
                  aria-label={`Edit ${milestone.title}`}
                  onSubmit={(event) => save(event, milestone.id)}
                >
                  <MilestoneFields initial={milestone} titleRef={editTitle} />
                  <button className="action" type="submit">
                    {saving ? "Saving…" : "Save milestone"}
                  </button>
                  <button
                    type="button"
                    className="label-secondary"
                    onClick={() => {
                      setEditing(null);
                      pendingFocus.current = `${milestone.id}:edit`;
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <div className="milestone-heading">
                    <h2>{milestone.title}</h2>
                    <span className="label-row-actions">
                      <button
                        type="button"
                        ref={(element) => {
                          if (element)
                            buttons.current.set(
                              `${milestone.id}:edit`,
                              element,
                            );
                        }}
                        aria-label={`Edit ${milestone.title}`}
                        onClick={() => {
                          pendingFocus.current = "edit-form";
                          setEditing(milestone.id);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`${milestone.closed ? "Reopen" : "Close"} ${milestone.title}`}
                        aria-disabled={saving}
                        onClick={() => toggleClosed(milestone)}
                      >
                        {milestone.closed ? "Reopen" : "Close"}
                      </button>
                    </span>
                  </div>
                  <p className="milestone-meta">
                    {milestone.projectId ? (
                      <Link to={`/projects/${milestone.projectId}`}>
                        {projectNames.get(milestone.projectId) ?? "Project"}
                      </Link>
                    ) : (
                      "Whole workspace"
                    )}
                    {milestone.dueDate && (
                      <>
                        {" · Due "}
                        <time dateTime={milestone.dueDate}>
                          {milestone.dueDate}
                        </time>
                      </>
                    )}
                    {milestone.closed && " · Closed"}
                  </p>
                  {milestone.description && <p>{milestone.description}</p>}
                  <Progress milestone={milestone} />
                  <Link
                    to={`/issues?state=all&milestone=${milestone.id}`}
                    aria-label={`View issues in ${milestone.title}`}
                  >
                    View issues
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
