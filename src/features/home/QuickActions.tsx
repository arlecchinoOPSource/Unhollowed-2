import { CalendarPlus, FilePlus, ListPlus } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { links } from "../../app/links";
import { createDocument } from "../../database/documents";
import { deviceZone } from "../../database/events";
import {
  createIssue,
  issueError,
  queryIssues,
  type IssueSummary,
} from "../../database/issues";
import { listProjects } from "../../database/projects";
import { queryKey, useSharedQuery } from "../../database/sharedQuery";
import { newDraft } from "../calendar/eventDraft";
import { useEventEditing } from "../calendar/useEventEditing";
import { Modal } from "../dashboard/WidgetLibrary";
import { activeProjects } from "./homeData";

/**
 * Everyday actions on Home. Each one reaches the workflow that already owns
 * the record: the same create commands, the same event editor, the same issue
 * and check-in screens. Nothing here is a second form for a record.
 */
export function QuickActions({ today }: { today: string }) {
  const navigate = useNavigate();
  const issueButton = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [picking, setPicking] = useState(false);
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [pickError, setPickError] = useState("");
  const planButton = useRef<HTMLButtonElement>(null);

  const events = useEventEditing({
    onMessage: setMessage,
    onChanged: () => undefined,
  });

  const projects = useSharedQuery(
    queryKey("home-projects", today),
    ["projects"],
    listProjects,
    () => "",
  );
  const recent = projects.data
    ? activeProjects(projects.data, 1)[0]
    : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError("");
    try {
      const issue = await createIssue({
        title: name,
        description: null,
        priority: null,
        startDate: null,
        dueDate: null,
      });
      setTitle("");
      setAdding(false);
      setMessage(`Created ISS-${issue.number} ${issue.title}.`);
      issueButton.current?.focus();
    } catch (cause) {
      // The draft stays, so nothing typed is lost; focus stays in the field.
      setError(issueError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function newDocument() {
    setError("");
    try {
      const doc = await createDocument();
      navigate(links.document(doc.id), {
        state: { from: "/", fromLabel: "Home" },
      });
    } catch {
      setError("Could not create the document. Try again.");
    }
  }

  async function plan() {
    setPickError("");
    setPicking(true);
    try {
      const page = await queryIssues({
        state: "open",
        sort: "due",
        direction: "asc",
        limit: 50,
      });
      setIssues(page.issues);
      setChosen(page.issues[0]?.id ?? "");
    } catch (cause) {
      setIssues([]);
      setPickError(issueError(cause));
    }
  }

  return (
    <section aria-labelledby="home-actions" className="home-actions">
      <h2 id="home-actions">Quick actions</h2>
      <div className="home-action-row">
        <button
          ref={issueButton}
          type="button"
          className="action"
          aria-expanded={adding}
          onClick={() => {
            setAdding(!adding);
            setMessage("");
          }}
        >
          <ListPlus size={15} aria-hidden="true" /> New issue
        </button>
        <button type="button" className="action" onClick={newDocument}>
          <FilePlus size={15} aria-hidden="true" /> New document
        </button>
        <button
          type="button"
          className="action"
          onClick={() =>
            events.openNew(
              newDraft(today, deviceZone(), events.defaultCalendar),
            )
          }
        >
          <CalendarPlus size={15} aria-hidden="true" /> Add event
        </button>
        <button
          ref={planButton}
          type="button"
          className="action"
          onClick={plan}
        >
          Schedule issue work
        </button>
        <Link className="action" to="/mood">
          Record a check-in
        </Link>
        {recent ? (
          <Link className="action" to={links.project(recent.id)}>
            Open {recent.name}
          </Link>
        ) : (
          <span className="home-muted">No active project to open.</span>
        )}
      </div>
      {adding && (
        <form className="home-quick-issue" onSubmit={submit}>
          <label>
            Issue title
            <input
              autoFocus
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="action"
            disabled={busy || title.trim() === ""}
          >
            Create issue
          </button>
          <button
            type="button"
            className="action"
            onClick={() => {
              setAdding(false);
              setError("");
              issueButton.current?.focus();
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {events.error && <p role="alert">{events.error}</p>}
      {events.editor}
      {picking && (
        <Modal
          title="Schedule issue work"
          onClose={() => {
            setPicking(false);
            setIssues(null);
            planButton.current?.focus();
          }}
        >
          {issues === null ? (
            <p role="status">Loading…</p>
          ) : issues.length === 0 ? (
            <p role={pickError ? "alert" : undefined}>
              {pickError || "You have no open issues to plan work for."}
            </p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setPicking(false);
                navigate(links.issue(chosen), { state: { from: "/" } });
              }}
            >
              <p>
                Work sessions are planned on the issue itself. Choose the issue
                to open its work sessions.
              </p>
              <label className="dash-field">
                Issue
                <select
                  value={chosen}
                  onChange={(event) => setChosen(event.target.value)}
                >
                  {issues.map((issue) => (
                    <option key={issue.id} value={issue.id}>
                      ISS-{issue.number} {issue.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="dash-library-actions">
                <button type="submit" className="action">
                  Open issue
                </button>
                <button
                  type="button"
                  className="action"
                  onClick={() => {
                    setPicking(false);
                    planButton.current?.focus();
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </section>
  );
}
