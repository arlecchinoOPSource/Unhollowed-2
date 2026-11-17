import { FileText, FolderKanban, Link2Off } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { schedulingError } from "../../database/calendars";
import { listDocuments, type DocumentSummary } from "../../database/documents";
import {
  getEventLinks,
  linkEventRecord,
  unlinkEventRecord,
  type EventLinks as Links,
  type LinkedRecord,
  type LinkTarget,
} from "../../database/events";
import { listProjects, type Project } from "../../database/projects";
import "../documents/documentLinks.css";

const labels: Record<LinkTarget, { one: string; heading: string }> = {
  document: { one: "document", heading: "Linked documents" },
  project: { one: "project", heading: "Linked projects" },
};

function path(target: LinkTarget, id: string) {
  return target === "document"
    ? `/documents?doc=${encodeURIComponent(id)}`
    : `/projects/${id}`;
}

/**
 * The documents and projects a saved event links to. Links belong to the
 * event, so every occurrence of a repeating event shows the same ones.
 * Unlinking removes only the link, never the document or project.
 */
export function EventLinks({ eventId }: { eventId: string }) {
  const [links, setLinks] = useState<Links | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    Promise.all([getEventLinks(eventId), listDocuments(), listProjects()]).then(
      ([loaded, allDocuments, allProjects]) => {
        if (!current) return;
        setLinks(loaded);
        setDocuments(allDocuments);
        setProjects(allProjects);
      },
      (cause) => current && setError(schedulingError(cause)),
    );
    return () => {
      current = false;
    };
  }, [eventId]);

  async function change(
    work: () => Promise<Links>,
    done: string,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setLinks(await work());
      setMessage(done);
      return true;
    } catch (cause) {
      setError(schedulingError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const pickable: Record<LinkTarget, { id: string; title: string }[]> = {
    document: documents,
    project: projects
      .filter(({ status }) => status !== "archived")
      .map(({ id, name }) => ({ id, title: name })),
  };

  return (
    <div className="document-links">
      {(["document", "project"] as const).map((target) => (
        <Section
          key={target}
          target={target}
          linked={
            links && (target === "document" ? links.documents : links.projects)
          }
          options={pickable[target]}
          busy={busy}
          onLink={(id, title) =>
            change(
              () => linkEventRecord(eventId, target, id),
              `Linked ${title}.`,
            )
          }
          onUnlink={(record) =>
            change(
              () => unlinkEventRecord(eventId, target, record.id),
              `Unlinked ${record.title}. The ${labels[target].one} itself is unchanged.`,
            )
          }
        />
      ))}
      {error && <p role="alert">{error}</p>}
      <p role="status">{message}</p>
    </div>
  );
}

function Section({
  target,
  linked,
  options,
  busy,
  onLink,
  onUnlink,
}: {
  target: LinkTarget;
  linked: LinkedRecord[] | null;
  options: { id: string; title: string }[];
  busy: boolean;
  onLink: (id: string, title: string) => Promise<boolean>;
  onUnlink: (record: LinkedRecord) => Promise<boolean>;
}) {
  const [choice, setChoice] = useState("");
  const { one, heading } = labels[target];
  const linkedIds = new Set(linked?.map(({ id }) => id));
  const available = options.filter(({ id }) => !linkedIds.has(id));
  const Icon = target === "document" ? FileText : FolderKanban;
  const id = `event-links-${target}`;
  return (
    <section aria-labelledby={id}>
      <h3 id={id}>{heading}</h3>
      {linked === null ? (
        <p>Loading…</p>
      ) : linked.length === 0 ? (
        <p>None linked yet.</p>
      ) : (
        <ul>
          {linked.map((record) => (
            <li key={record.id}>
              <Icon size={15} aria-hidden="true" />
              <Link to={path(target, record.id)}>{record.title}</Link>
              {record.archived && <span>(archived)</span>}
              <button
                type="button"
                aria-label={`Unlink ${record.title}`}
                title="Unlink"
                aria-disabled={busy}
                onClick={() => !busy && void onUnlink(record)}
              >
                <Link2Off size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {linked !== null && (
        <div>
          <label>
            Link a {one}
            <select
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
            >
              <option value="">
                {available.length === 0
                  ? `No other ${one}s`
                  : `Choose a ${one}`}
              </option>
              {available.map(({ id: value, title }) => (
                <option key={value} value={value}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="action"
            aria-disabled={!choice || busy}
            onClick={async () => {
              const picked = available.find(
                ({ id: value }) => value === choice,
              );
              if (!picked || busy) return;
              if (await onLink(picked.id, picked.title)) setChoice("");
            }}
          >
            Link {one}
          </button>
        </div>
      )}
    </section>
  );
}
