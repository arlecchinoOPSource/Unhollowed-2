import { ArrowLeft, Flag, Kanban, List, Tags } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  getProject,
  projectError,
  type Project,
} from "../../database/projects";
import { isTauri } from "../../database/status";
import { IssueBoard } from "./IssueBoard";
import { IssueList } from "./IssueList";

export function Issues() {
  return (
    <section>
      <div className="issue-page-top">
        <div>
          <h1>Issues</h1>
        </div>
        <span className="issue-page-links">
          <ViewLink to="/issues/board" board />
          <Link className="issue-manage" to="/issues/milestones">
            <Flag size={16} aria-hidden="true" /> Milestones
          </Link>
          <Link className="issue-manage" to="/issues/labels">
            <Tags size={16} aria-hidden="true" /> Manage labels
          </Link>
        </span>
      </div>
      <IssueList />
    </section>
  );
}

/** Switches between list and board, keeping the current filters. */
function ViewLink({ to, board = false }: { to: string; board?: boolean }) {
  const { search } = useLocation();
  const Icon = board ? Kanban : List;
  return (
    <Link className="issue-manage" to={`${to}${search}`}>
      <Icon size={16} aria-hidden="true" /> {board ? "Board view" : "List view"}
    </Link>
  );
}

/** All Issues as a board, with the same filters as the list. */
export function IssueBoardPage() {
  return (
    <section>
      <div className="issue-page-top">
        <div>
          <h1>Board</h1>
        </div>
        <span className="issue-page-links">
          <ViewLink to="/issues" />
        </span>
      </div>
      <IssueBoard />
    </section>
  );
}

/** A project's issues, using the same list as All Issues. */
export function ProjectIssues() {
  const { id } = useParams();
  return <ProjectIssueList key={id} id={id!} />;
}

/** A project's issues as a board. */
export function ProjectBoard() {
  const { id } = useParams();
  return <ProjectIssueList key={id} id={id!} board />;
}

function ProjectIssueList({
  id,
  board = false,
}: {
  id: string;
  board?: boolean;
}) {
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
      <div className="issue-page-top">
        <h1>{board ? "Board" : "Issues"}</h1>
        <span className="issue-page-links">
          <ViewLink
            to={board ? `/projects/${id}/issues` : `/projects/${id}/board`}
            board={!board}
          />
        </span>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <p>
            {project
              ? `Work planned for ${project.name}.`
              : "Work planned for this project."}
          </p>
          {board ? <IssueBoard projectId={id} /> : <IssueList projectId={id} />}
        </>
      )}
    </section>
  );
}
