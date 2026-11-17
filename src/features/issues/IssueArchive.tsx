import { Archive, ArchiveRestore } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  archiveIssue,
  deleteIssue,
  getIssueDeletionImpact,
  issueError,
  issueKey,
  restoreIssue,
  type DeletionImpact,
  type Issue,
} from "../../database/issues";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Archives an issue. Shown in the properties of issues that are not archived. */
export function ArchiveButton({
  issue,
  onSaved,
  onError,
}: {
  issue: Issue;
  onSaved: (issue: Issue, message: string) => void;
  onError: (message: string) => void;
}) {
  return (
    <button
      type="button"
      className="action issue-archive-button"
      onClick={() =>
        archiveIssue(issue.id).then(
          (saved) =>
            onSaved(
              saved,
              "Issue archived. It is hidden from lists and progress, and keeps all its links.",
            ),
          (cause) => onError(issueError(cause)),
        )
      }
    >
      <Archive size={16} aria-hidden="true" /> Archive issue
    </button>
  );
}

/**
 * The banner on an archived issue: restore it, or open the separate,
 * confirmed permanent deletion.
 */
export function ArchivedBanner({
  issue,
  onSaved,
  onError,
}: {
  issue: Issue;
  onSaved: (issue: Issue, message: string) => void;
  onError: (message: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const restoreButton = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div className="issue-archive-banner" role="note">
        <p>
          <strong>This issue is archived.</strong> It is hidden from lists,
          boards, and progress, and keeps all its links.
        </p>
        <button
          type="button"
          ref={restoreButton}
          className="action"
          onClick={() =>
            restoreIssue(issue.id).then(
              (saved) => onSaved(saved, "Issue restored."),
              (cause) => onError(issueError(cause)),
            )
          }
        >
          <ArchiveRestore size={16} aria-hidden="true" /> Restore issue
        </button>
        {!deleting && (
          <button
            type="button"
            className="label-secondary"
            onClick={() => setDeleting(true)}
          >
            Delete permanently…
          </button>
        )}
      </div>
      {deleting && (
        <DeletePanel
          issue={issue}
          onCancel={() => {
            setDeleting(false);
            requestAnimationFrame(() => restoreButton.current?.focus());
          }}
        />
      )}
    </>
  );
}

function DeletePanel({
  issue,
  onCancel,
}: {
  issue: Issue;
  onCancel: () => void;
}) {
  const navigate = useNavigate();
  const [impact, setImpact] = useState<DeletionImpact | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    getIssueDeletionImpact(issue.id).then(
      (loaded) => {
        if (current) setImpact(loaded);
      },
      (cause) => {
        if (current) setError(issueError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [issue.id]);

  useEffect(() => {
    if (impact) input.current?.focus();
  }, [impact]);

  const key = impact?.key ?? issueKey(issue);
  const blockers = impact
    ? [
        impact.subIssues > 0 &&
          `It has ${plural(impact.subIssues, "sub-issue")}. Remove or reassign them first.`,
        impact.activeSeries &&
          "It is the latest occurrence of a repeating issue. Stop repeating it first.",
      ].filter((reason): reason is string => Boolean(reason))
    : [];
  const removed = impact
    ? [
        impact.labels > 0 && plural(impact.labels, "label link"),
        impact.documents > 0 && plural(impact.documents, "document link"),
        impact.objectives > 0 && plural(impact.objectives, "objective link"),
        impact.workBlocks > 0 && plural(impact.workBlocks, "work session"),
        impact.relationships > 0 &&
          plural(impact.relationships, "relationship"),
      ].filter((item): item is string => Boolean(item))
    : [];
  const ready =
    impact !== null &&
    blockers.length === 0 &&
    typed.trim().toUpperCase() === key.toUpperCase() &&
    !deleting;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setDeleting(true);
    setError("");
    try {
      await deleteIssue(issue.id, typed);
      void navigate("/issues?archived=only", {
        replace: true,
        state: { deleted: key },
      });
    } catch (cause) {
      setError(issueError(cause));
      setDeleting(false);
    }
  }

  return (
    <section className="issue-delete" aria-labelledby="issue-delete-heading">
      <h2 id="issue-delete-heading">Delete {key} permanently</h2>
      {!impact && !error && <p>Checking what this affects…</p>}
      {impact && (
        <>
          <p>
            This cannot be undone. The issue's number will not be reused.
            Documents, labels, projects, milestones, and other issues are kept.
          </p>
          {removed.length > 0 ? (
            <p>Also removed with it: {removed.join(", ")}.</p>
          ) : (
            <p>It has no links to remove.</p>
          )}
          {blockers.length > 0 && (
            <ul role="alert">
              {blockers.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <form onSubmit={submit}>
            <label>
              Type {key} to confirm
              <input
                ref={input}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="issue-delete-heading"
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="issue-danger"
              aria-disabled={!ready}
            >
              {deleting ? "Deleting…" : `Delete ${key}`}
            </button>
            <button
              type="button"
              className="label-secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
          </form>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
