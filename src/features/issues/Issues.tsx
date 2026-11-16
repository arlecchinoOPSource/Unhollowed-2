import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  getProject,
  projectError,
  type Project,
} from "../../database/projects";
import { isTauri } from "../../database/status";
import { IssueList } from "./IssueList";

export function Issues() {
  return (
    <section>
      <h1>Issues</h1>
      <p>Review, update, and complete your work across every project.</p>
      <IssueList />
    </section>
  );
}

/** A project's issues, using the same list as All Issues. */
export function ProjectIssues() {
  const { id } = useParams();
  return <ProjectIssueList key={id} id={id!} />;
}

function ProjectIssueList({ id }: { id: string }) {
  const desktop = isTauri();
  const [project, setProject] = useState<Project>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    getProject(id).then(
      (loaded) => {
        if (current) setProject(loaded);
      },
      (cause) => {
        if (current) setError(projectError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, id]);

  return (
    <section>
      <Link className="issue-back" to={`/projects/${id}`}>
        <ArrowLeft size={16} aria-hidden="true" />
        {project ? project.name : "Project"}
      </Link>
      <h1>Issues</h1>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <p>
            {project
              ? `Work planned for ${project.name}.`
              : "Work planned for this project."}
          </p>
          <IssueList projectId={id} />
        </>
      )}
    </section>
  );
}
