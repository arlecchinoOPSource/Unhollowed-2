import { ArrowLeft, Flag, ListTodo } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { isRecordId } from "../../app/links";
import {
  changeProjectStatus,
  getProject,
  projectError,
  projectStatuses,
  updateProject,
  type Project,
  type ProjectStatus,
} from "../../database/projects";
import { ProjectDocuments } from "../documents/LinkedDocuments";
import { ProjectDialog } from "./ProjectDialog";
import { ProjectOverview } from "./ProjectOverview";

export function ProjectDetail() {
  const { id } = useParams();
  return <ProjectDetails key={id} id={id!} />;
}

function ProjectDetails({ id }: { id: string }) {
  const [project, setProject] = useState<Project>();
  const [fetchError, setError] = useState("");
  const error = isRecordId(id)
    ? fetchError
    : "This link does not name a project.";
  const [request, setRequest] = useState(0);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!isRecordId(id)) return;
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
                aria-disabled={saving}
                onChange={(event) => {
                  if (!saving)
                    void setStatus(event.target.value as ProjectStatus);
                }}
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
          <ProjectOverview projectId={id} />
          <div className="project-grid">
            <Link className="project-card" to={`/projects/${id}/issues`}>
              <ListTodo size={19} aria-hidden="true" />
              <h2>Issues</h2>
              <p>Review and update the work in this project.</p>
            </Link>
            <Link
              className="project-card"
              to={`/issues/milestones?project=${id}`}
            >
              <Flag size={19} aria-hidden="true" />
              <h2>Milestones</h2>
              <p>Plan checkpoints and track progress for this project.</p>
            </Link>
            <Link className="project-card" to={`/projects/${id}/goals`}>
              <Flag size={19} aria-hidden="true" />
              <h2>Missions &amp; objectives</h2>
              <p>Define project goals and connect them to issues.</p>
            </Link>
          </div>
          <div className="project-documents">
            <ProjectDocuments
              projectId={id}
              origin={{ from: `/projects/${id}`, fromLabel: project.name }}
            />
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
