import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { issueKey, listIssues, type IssueSummary } from "../../database/issues";
import {
  addRelationship,
  listRelationships,
  relationError,
  relationKinds,
  removeRelationship,
  type IssueRelationship,
  type RelationKind,
} from "../../database/relationships";
import { StatusBadge } from "./IssueBadges";

export function IssueRelationships({ id, back }: { id: string; back: string }) {
  const [links, setLinks] = useState<IssueRelationship[]>();
  const [candidates, setCandidates] = useState<IssueSummary[]>();
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let current = true;
    listRelationships(id).then(
      (items) => {
        if (current) setLinks(items);
      },
      (cause) => {
        if (current) setError(relationError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [id, refresh]);

  useEffect(() => {
    if (!adding) return;
    let current = true;
    listIssues().then(
      (items) => {
        if (current) setCandidates(items.filter((issue) => issue.id !== id));
      },
      (cause) => {
        if (current) setError(relationError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [id, adding]);

  async function change(operation: () => Promise<void>) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await operation();
      setAdding(false);
      setLinks(undefined);
      setRefresh((n) => n + 1);
    } catch (cause) {
      setError(relationError(cause));
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const other = String(form.get("issue"));
    const kind = String(form.get("relationship")) as RelationKind;
    if (other) void change(() => addRelationship(id, other, kind));
  }

  const children = links?.filter((link) => link.kind === "child") ?? [];
  return (
    <section
      className="issue-relationships"
      aria-labelledby="issue-relationship-title"
    >
      <h2 id="issue-relationship-title">Relationships</h2>
      {children.length > 0 && (
        <p>
          {children.filter((child) => child.status === "done").length} of{" "}
          {children.length} sub-issues done
        </p>
      )}
      {!links && !error && <p role="status">Loading relationships…</p>}
      {links?.length === 0 && <p>No issue relationships yet.</p>}
      {links && links.length > 0 && (
        <ul>
          {links.map((relation) => (
            <li key={`${relation.kind}:${relation.id}`}>
              <span>{relationKinds[relation.kind]}</span>
              <Link to={`/issues/${relation.id}`} state={{ from: back }}>
                {issueKey(relation)} {relation.title}
              </Link>
              <StatusBadge status={relation.status} />
              {relation.archived && (
                <span className="issue-archived">Archived</span>
              )}
              <button
                className="project-secondary"
                type="button"
                aria-label={`Remove ${relationKinds[relation.kind]} link to ${issueKey(relation)}`}
                disabled={saving}
                onClick={() =>
                  void change(() =>
                    removeRelationship(id, relation.id, relation.kind),
                  )
                }
              >
                Remove link
              </button>
            </li>
          ))}
        </ul>
      )}
      {links && !adding && (
        <button
          className="action"
          type="button"
          disabled={saving}
          onClick={() => setAdding(true)}
        >
          Add relationship
        </button>
      )}
      {adding && (
        <form onSubmit={submit}>
          <fieldset disabled={saving}>
            <label>
              Relationship
              <select name="relationship">
                {Object.entries(relationKinds).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Issue
              <select name="issue" required disabled={!candidates?.length}>
                <option value="">Choose an issue</option>
                {candidates?.map((issue) => (
                  <option key={issue.id} value={issue.id}>
                    {issueKey(issue)} {issue.title}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          {candidates?.length === 0 && (
            <p>Create another issue to link it here.</p>
          )}
          <button className="action" disabled={saving || !candidates?.length}>
            Save relationship
          </button>
          <button
            className="project-secondary"
            type="button"
            disabled={saving}
            onClick={() => {
              setAdding(false);
              setCandidates(undefined);
              setError("");
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {!links && error && (
        <button
          className="action"
          onClick={() => {
            setError("");
            setRefresh((n) => n + 1);
          }}
        >
          Retry relationships
        </button>
      )}
    </section>
  );
}
