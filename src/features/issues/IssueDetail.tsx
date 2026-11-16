import { EditorContent } from "@tiptap/react";
import { ArrowLeft, CircleCheck, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  FormattingToolbar,
  useRichTextEditor,
} from "../../components/editor/RichText";
import {
  changeIssueStatus,
  completeIssue,
  getIssue,
  isClosedStatus,
  issueError,
  issueErrorCode,
  issueKey,
  issuePriorities,
  issueStatuses,
  reopenIssue,
  setIssueLabels,
  setIssueProject,
  updateIssue,
  type Issue,
  type IssuePriority,
  type IssueStatus,
} from "../../database/issues";
import { listLabels, type Label } from "../../database/labels";
import { listProjects, type Project } from "../../database/projects";
import { isTauri } from "../../database/status";
import { LabelPicker } from "../labels/LabelParts";
import { StatusBadge } from "./IssueBadges";
import "./issues.css";

const SAVE_DELAY_MS = 700;

interface Draft {
  title: string;
  description: string;
  priority: IssuePriority;
  startDate: string | null;
  dueDate: string | null;
}

// Keep unsaved drafts available when the editor unmounts during a write.
const unsavedDrafts = new Map<string, Draft>();

function draftOf(issue: Issue): Draft {
  const { title, description, priority, startDate, dueDate } = issue;
  return { title, description, priority, startDate, dueDate };
}

export function IssueDetail() {
  const { id } = useParams();
  return <IssueLoader key={id} id={id!} />;
}

function IssueLoader({ id }: { id: string }) {
  const desktop = isTauri();
  const location = useLocation();
  const from = (location.state as { from?: unknown } | null)?.from;
  const back = typeof from === "string" ? from : "/issues";
  const [loaded, setLoaded] = useState<{
    issue: Issue;
    projects: Project[];
    labels: Label[];
  }>();
  const [error, setError] = useState<{ message: string; missing: boolean }>();
  const [request, setRequest] = useState(0);

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    Promise.all([getIssue(id), listProjects(), listLabels()]).then(
      ([issue, projects, labels]) => {
        if (current) setLoaded({ issue, projects, labels });
      },
      (cause) => {
        if (current)
          setError({
            message: issueError(cause),
            missing: issueErrorCode(cause) === "not_found",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, id, request]);

  return (
    <section>
      <Link className="issue-back" to={back}>
        <ArrowLeft size={16} aria-hidden="true" />
        {back.startsWith("/projects/") ? "Project issues" : "All issues"}
      </Link>
      {!desktop && <p>Open the desktop app to manage your local issues.</p>}
      {error && (
        <div role="alert">
          <h1>
            {error.missing ? "Issue unavailable" : "Could not open issue"}
          </h1>
          <p>{error.message}</p>
          {!error.missing && (
            <button
              className="action"
              onClick={() => {
                setError(undefined);
                setRequest(request + 1);
              }}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {desktop && !error && !loaded && <p>Loading issue…</p>}
      {loaded && (
        <IssueEditor
          initial={loaded.issue}
          projects={loaded.projects}
          labels={loaded.labels}
        />
      )}
    </section>
  );
}

function IssueEditor({
  initial,
  projects,
  labels,
}: {
  initial: Issue;
  projects: Project[];
  labels: Label[];
}) {
  const id = initial.id;
  const [recovered] = useState(() => unsavedDrafts.get(id));
  // `issue` is the latest server state with optimistic status and project
  // changes applied. `fields` holds the editable values, which can be ahead
  // of the server while typing.
  const [issue, setIssue] = useState(initial);
  const [fields, setFields] = useState(() => recovered ?? draftOf(initial));
  const [pending, setPending] = useState(0);
  const [unsaved, setUnsaved] = useState(false);
  const [failed, setFailed] = useState(Boolean(recovered));
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const draft = useRef(recovered ?? draftOf(initial));
  const saved = useRef(initial);
  const dirty = useRef(Boolean(recovered));
  const timer = useRef<number>(undefined);
  const inFlight = useRef(0);

  // Every change goes through the serialized issue write queue, so the last
  // response always reflects every earlier change.
  function run(
    operation: Promise<Issue>,
    onFailure: (cause: unknown) => void,
    done = "",
  ) {
    inFlight.current += 1;
    setPending(inFlight.current);
    setError("");
    setMessage("");
    operation.then(
      (result) => {
        saved.current = result;
        inFlight.current -= 1;
        setPending(inFlight.current);
        if (inFlight.current === 0) setIssue(result);
        if (done) setMessage(done);
      },
      (cause) => {
        inFlight.current -= 1;
        setPending(inFlight.current);
        if (inFlight.current === 0) setIssue(saved.current);
        onFailure(cause);
        setError(issueError(cause));
      },
    );
  }

  function saveFields() {
    window.clearTimeout(timer.current);
    setUnsaved(false);
    if (!dirty.current) return;
    dirty.current = false;
    const snapshot = draft.current;
    const input = {
      ...snapshot,
      title: draft.current.title.trim() || saved.current.title,
    };
    const saving = updateIssue(id, input).then((result) => {
      if (unsavedDrafts.get(id) === snapshot) unsavedDrafts.delete(id);
      setFailed(false);
      return result;
    });
    run(saving, () => {
      setFailed(true);
      // Keep the rejected values available for correction or explicit retry.
      dirty.current = true;
    });
  }

  function schedule() {
    unsavedDrafts.set(id, draft.current);
    dirty.current = true;
    setUnsaved(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(saveFields, SAVE_DELAY_MS);
  }

  // Leaving the page unmounts this component. Flush typed edits so they are
  // saved before the next screen reads its list.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (timer.current !== undefined && dirty.current) saveFields();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useRichTextEditor(
    "Issue description",
    recovered?.description ?? initial.description,
    (description) => {
      draft.current = { ...draft.current, description };
      schedule();
    },
  );

  function changeProperty<K extends "priority" | "startDate" | "dueDate">(
    key: K,
    value: Draft[K],
  ) {
    const next = { ...draft.current, [key]: value };
    // Check the range here so an invalid date is never sent. The input keeps
    // its saved value because `fields` is unchanged.
    if (next.startDate && next.dueDate && next.startDate > next.dueDate) {
      setMessage("");
      setError(issueError({ code: "invalid_date_range" }));
      return;
    }
    draft.current = next;
    unsavedDrafts.set(id, next);
    setFields((current) => ({ ...current, [key]: value }));
    dirty.current = true;
    saveFields();
  }

  function changeStatus(status: IssueStatus) {
    setIssue((current) => ({
      ...current,
      status,
      closed: isClosedStatus(status),
    }));
    run(
      changeIssueStatus(id, status),
      () => undefined,
      `Status changed to ${issueStatuses[status]}.`,
    );
  }

  function toggleClosed() {
    if (issue.closed) {
      setIssue((current) => ({ ...current, status: "todo", closed: false }));
      run(reopenIssue(id), () => undefined, "Issue reopened.");
    } else {
      setIssue((current) => ({ ...current, status: "done", closed: true }));
      run(completeIssue(id), () => undefined, "Issue completed.");
    }
  }

  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const projectOptions = projects
    .filter(
      (project) =>
        project.status !== "archived" || project.id === issue.projectId,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const projectName = issue.projectId && projectNames.get(issue.projectId);

  function changeProject(projectId: string | null) {
    setIssue((current) => ({ ...current, projectId }));
    run(
      setIssueProject(id, projectId),
      () => undefined,
      projectId
        ? `Moved to ${projectNames.get(projectId) ?? "the project"}.`
        : "Moved to the Inbox.",
    );
  }

  function changeLabels(labelIds: string[]) {
    setIssue((current) => ({ ...current, labelIds }));
    run(setIssueLabels(id, labelIds), () => undefined, "Labels updated.");
  }

  const status =
    pending > 0 || unsaved
      ? "Saving…"
      : failed
        ? "Changes not saved. Retry or keep editing."
        : message || "All changes saved";

  return (
    <div className="issue-detail">
      <div className="issue-main">
        <h1 className="visually-hidden">
          {issueKey(issue)} {issue.title}
        </h1>
        <p className="issue-heading">
          <span className="issue-key">{issueKey(issue)}</span>
          <StatusBadge status={issue.status} />
        </p>
        <label className="visually-hidden" htmlFor="issue-title">
          Issue title
        </label>
        <input
          id="issue-title"
          className="document-title"
          value={fields.title}
          maxLength={200}
          onChange={(event) => {
            const title = event.target.value;
            draft.current = { ...draft.current, title };
            setFields((current) => ({ ...current, title }));
            schedule();
          }}
          onBlur={() => {
            saveFields();
            if (!draft.current.title.trim()) {
              const title = saved.current.title;
              draft.current.title = title;
              setFields((current) => ({ ...current, title }));
            }
          }}
        />
        <FormattingToolbar editor={editor} />
        <EditorContent editor={editor} className="editor" />
        <p role="status" className="save-status">
          {status}
        </p>
        {failed && pending === 0 && (
          <button type="button" className="action" onClick={saveFields}>
            Retry save
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <section
        className="issue-properties"
        aria-labelledby="issue-properties-heading"
      >
        <h2 id="issue-properties-heading">Properties</h2>
        <button type="button" className="action" onClick={toggleClosed}>
          {issue.closed ? (
            <>
              <RotateCcw size={16} aria-hidden="true" /> Reopen issue
            </>
          ) : (
            <>
              <CircleCheck size={16} aria-hidden="true" /> Mark complete
            </>
          )}
        </button>
        <label>
          Status
          <select
            value={issue.status}
            onChange={(event) =>
              changeStatus(event.target.value as IssueStatus)
            }
          >
            {Object.entries(issueStatuses).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            value={fields.priority}
            onChange={(event) =>
              changeProperty("priority", event.target.value as IssuePriority)
            }
          >
            {Object.entries(issuePriorities).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project
          <select
            value={issue.projectId ?? ""}
            onChange={(event) => changeProject(event.target.value || null)}
          >
            <option value="">Inbox (no project)</option>
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {issue.projectId && projectName && (
          <Link className="issue-project" to={`/projects/${issue.projectId}`}>
            Open project {projectName}
          </Link>
        )}
        <LabelPicker
          legend="Labels"
          labels={labels}
          selected={issue.labelIds}
          retained={initial.labelIds}
          onChange={changeLabels}
        />
        <Link className="issue-manage" to="/issues/labels">
          Manage labels
        </Link>
        <label>
          Start date
          <input
            type="date"
            value={fields.startDate ?? ""}
            onChange={(event) =>
              changeProperty("startDate", event.target.value || null)
            }
          />
        </label>
        <label>
          Due date
          <input
            type="date"
            value={fields.dueDate ?? ""}
            onChange={(event) =>
              changeProperty("dueDate", event.target.value || null)
            }
          />
        </label>
        <dl>
          <div>
            <dt>Created</dt>
            <dd>
              <time dateTime={issue.createdAt}>
                {issue.createdAt.slice(0, 10)}
              </time>
            </dd>
          </div>
          {issue.completedAt && (
            <div>
              <dt>Completed</dt>
              <dd>
                <time dateTime={issue.completedAt}>
                  {issue.completedAt.slice(0, 10)}
                </time>
              </dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  );
}
