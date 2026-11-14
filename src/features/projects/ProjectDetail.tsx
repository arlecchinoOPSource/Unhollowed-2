import {
  ArrowLeft,
  Flag,
  LayoutDashboard,
  ListTodo,
  Notebook,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  changeProjectStatus,
  getProject,
  projectError,
  projectStatuses,
  updateProject,
  type Project,
  type ProjectStatus,
} from "../../database/projects";
import { ProjectDialog } from "./ProjectDialog";

const sections = [
  { title: "Tasks", icon: ListTodo },
  { title: "Milestones", icon: Flag },
  { title: "Documents", icon: Notebook },
  { title: "Dashboard", icon: LayoutDashboard },
];

export function ProjectDetail() {
  const { id } = useParams();
  return <ProjectDetails key={id} id={id!} />;
}

function ProjectDetails({ id }: { id: string }) {
  const [project, setProject] = useState<Project>();
  const [error, setError] = useState("");
  const [request, setRequest] = useState(0);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let current = true;
    getProject(id).then(
      (item) => {
        if (current) setProject(item);
      },
      (cause) => {
        if (current) setError(projectError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [id, request]);

  async function setStatus(status: ProjectStatus) {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      setProject(await changeProjectStatus(id, status));
      setMessage(`Status updated to ${projectStatuses[status]}.`);
    } catch (cause) {
      setError(projectError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="projects-view">
      <Link className="project-back" to="/projects">
        <ArrowLeft size={16} aria-hidden="true" /> All projects
      </Link>
      {error && <p role="alert">{error}</p>}
      {!project &&
        (error ? (
          <button
            className="action"
            onClick={() => {
              setError("");
              setRequest(request + 1);
            }}
          >
            Retry
          </button>
        ) : (
          <p role="status">Loading project…</p>
        ))}
      {project && (
        <>
          <div className="project-page-top">
            <div>
              <h1>{project.name}</h1>
              {project.description && (
                <p className="project-description">{project.description}</p>
              )}
            </div>
            <button
              className="action"
              disabled={saving}
              onClick={() => setEditing(true)}
            >
              Edit project
            </button>
          </div>
          <div className="project-details">
            <label>
              Project status
              <select
                value={project.status}
                disabled={saving}
                onChange={(event) =>
                  void setStatus(event.target.value as ProjectStatus)
                }
              >
                {Object.entries(projectStatuses).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <dl className="project-dates">
              <div>
                <dt>Start date</dt>
                <dd>
                  {project.startDate ? (
                    <time dateTime={project.startDate}>
                      {project.startDate}
                    </time>
                  ) : (
                    "Not set"
                  )}
                </dd>
              </div>
              <div>
                <dt>Target date</dt>
                <dd>
                  {project.targetDate ? (
                    <time dateTime={project.targetDate}>
                      {project.targetDate}
                    </time>
                  ) : (
                    "Not set"
                  )}
                </dd>
              </div>
            </dl>
          </div>
          <p role="status">{saving ? "Saving status…" : message}</p>
          <div className="project-grid">
            {sections.map(({ title, icon: Icon }) => (
              <section className="project-card" key={title}>
                <Icon size={19} aria-hidden="true" />
                <h2>{title}</h2>
                <p>Planned for a future release.</p>
              </section>
            ))}
          </div>
          {editing && (
            <ProjectDialog
              project={project}
              onClose={() => setEditing(false)}
              save={async (input) => {
                setProject(await updateProject(id, input));
                setMessage("Project details saved.");
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
