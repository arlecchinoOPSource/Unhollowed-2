import { FileText, Link2Off } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import type { LinkedDocument } from "../../database/documentLinks";
import type { DocumentSummary } from "../../database/documents";
import "./documentLinks.css";

/** Where a document link came from, so the document page can link back. */
export interface LinkOrigin {
  from: string;
  fromLabel: string;
}

export function documentPath(id: string): string {
  return `/documents?doc=${encodeURIComponent(id)}`;
}

/**
 * Linked documents with unlink buttons and a picker for linking another
 * existing document. Used on issue and project pages.
 */
export function DocumentLinks({
  heading,
  linked,
  documents,
  origin,
  busy,
  onLink,
  onUnlink,
  children,
}: {
  heading: string;
  linked: LinkedDocument[] | null;
  /** Every document in the workspace, for the picker. */
  documents: DocumentSummary[];
  origin: LinkOrigin;
  busy: boolean;
  onLink: (documentId: string) => void;
  onUnlink: (document: LinkedDocument) => void;
  /** Extra content, such as documents inherited through issues. */
  children?: ReactNode;
}) {
  const [choice, setChoice] = useState("");
  const headingId = `links-${heading.replace(/\W+/g, "-").toLowerCase()}`;
  const linkedIds = new Set(linked?.map(({ id }) => id));
  const available = documents.filter(({ id }) => !linkedIds.has(id));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!choice || busy) return;
    onLink(choice);
    setChoice("");
  }

  return (
    <section className="document-links" aria-labelledby={headingId}>
      <h2 id={headingId}>{heading}</h2>
      {linked === null ? (
        <p>Loading documents…</p>
      ) : linked.length === 0 ? (
        <p>No documents linked yet.</p>
      ) : (
        <ul>
          {linked.map((document) => (
            <li key={document.id}>
              <FileText size={15} aria-hidden="true" />
              <Link to={documentPath(document.id)} state={origin}>
                {document.title}
              </Link>
              <button
                type="button"
                aria-label={`Unlink ${document.title}`}
                title="Unlink"
                aria-disabled={busy}
                onClick={() => !busy && onUnlink(document)}
              >
                <Link2Off size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {children}
      {linked !== null && (
        <form onSubmit={submit}>
          <label htmlFor={`${headingId}-choice`}>Link a document</label>
          <div>
            <select
              id={`${headingId}-choice`}
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
            >
              <option value="">
                {available.length === 0
                  ? "No other documents"
                  : "Choose a document"}
              </option>
              {available.map(({ id, title }) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="action"
              aria-disabled={!choice || busy}
            >
              Link
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
