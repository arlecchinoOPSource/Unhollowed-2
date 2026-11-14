import { isTauri } from "@tauri-apps/api/core";
import { ArrowUpRight, FolderKanban, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  createProject,
  listProjects,
  projectError,
  projectStatuses,
  type Project,
} from "../../database/projects";
import { ProjectDialog } from "./ProjectDialog";
import "./projects.css";

export function Projects() {
  const desktop = isTauri();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState("");
  const [request, setRequest] = useState(0);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    listProjects().then(
      (items) => {
        if (current) setProjects(items);
      },
      (cause) => {
        if (current) setError(projectError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, request]);

  const query = search.trim().toLowerCase();
  const visible =
    projects?.filter(
      (project) =>
        (status === "all" || status === project.status) &&
        (project.name.toLowerCase().includes(query) ||
          project.description?.toLowerCase().includes(query)),
    ) ?? [];

  return (
    <section className="projects-view">
      <div className="project-page-top">
        <div>
          <h1>Projects</h1>
          <p>Plan your work and track its progress.</p>
        </div>
        {desktop && (
          <button
            className="action project-primary"
            onClick={() => setCreating(true)}
          >
            <Plus size={17} aria-hidden="true" /> Create project
          </button>
        )}
      </div>
      {!desktop && <p>Open the desktop app to manage your local projects.</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            className="action"
            onClick={() => {
              setError("");
              setRequest(request + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {desktop && !error && projects === null && (
        <p role="status">Loading projects…</p>
      )}
      {projects?.length === 0 && (
        <div className="projects-empty">
          <FolderKanban size={24} aria-hidden="true" />
          <h2>No projects yet</h2>
          <p>Create a project to start organizing your work.</p>
        </div>
      )}
      {projects && projects.length > 0 && (
        <>
          <div className="project-filters">
            <label>
              Search projects
              <input
                type="search"
                placeholder="Search by name or description"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              Filter by status
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="all">All statuses</option>
                {Object.entries(projectStatuses).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {visible.length === 0 && (
            <p role="status">No projects match these filters.</p>
          )}
          <ul className="project-grid">
            {visible.map((project) => (
              <li key={project.id}>
                <Link className="project-card" to={`/projects/${project.id}`}>
                  <span className="project-card-top">
                    <span className="project-status">
                      {projectStatuses[project.status]}
                    </span>
                    <ArrowUpRight size={17} aria-hidden="true" />
                  </span>
                  <h2>{project.name}</h2>
                  {project.description && <p>{project.description}</p>}
                  {project.targetDate && (
                    <p>
                      Target{" "}
                      <time dateTime={project.targetDate}>
                        {project.targetDate}
                      </time>
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {creating && (
        <ProjectDialog
          onClose={() => setCreating(false)}
          save={async (input) => {
            const project = await createProject(input);
            await navigate(`/projects/${project.id}`);
          }}
        />
      )}
    </section>
  );
}
