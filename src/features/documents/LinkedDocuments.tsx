import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  linkError,
  linkIssueDocument,
  linkProjectDocument,
  listIssueDocuments,
  listProjectDocuments,
  unlinkIssueDocument,
  unlinkProjectDocument,
  type InheritedDocument,
  type LinkedDocument,
} from "../../database/documentLinks";
import { listDocuments, type DocumentSummary } from "../../database/documents";
import { DocumentLinks, documentPath, type LinkOrigin } from "./DocumentLinks";

function useLinking<T>(
  load: () => Promise<T>,
  key: string,
): {
  data: T | null;
  documents: DocumentSummary[];
  busy: boolean;
  error: string;
  message: string;
  run: (work: () => Promise<T>, done: string) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let current = true;
    Promise.all([load(), listDocuments()]).then(
      ([loaded, all]) => {
        if (!current) return;
        setData(loaded);
        setDocuments(all);
      },
      (cause) => {
        if (current) setError(linkError(cause));
      },
    );
    return () => {
      current = false;
    };
    // `key` identifies what `load` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function run(work: () => Promise<T>, done: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    work().then(
      (result) => {
        setData(result);
        setMessage(done);
        setBusy(false);
      },
      (cause) => {
        setError(linkError(cause));
        setBusy(false);
      },
    );
  }

  return { data, documents, busy, error, message, run };
}

function title(documents: DocumentSummary[], id: string): string {
  return documents.find((document) => document.id === id)?.title ?? "document";
}

/** Documents linked to an issue. */
export function IssueDocuments({
  issueId,
  origin,
}: {
  issueId: string;
  origin: LinkOrigin;
}) {
  const { data, documents, busy, error, message, run } = useLinking(
    () => listIssueDocuments(issueId),
    issueId,
  );
  return (
    <div className="linked-documents">
      <DocumentLinks
        heading="Linked documents"
        linked={data}
        documents={documents}
        origin={origin}
        busy={busy}
        onLink={(documentId) =>
          run(
            () => linkIssueDocument(issueId, documentId),
            `Linked ${title(documents, documentId)}.`,
          )
        }
        onUnlink={(document: LinkedDocument) =>
          run(
            () => unlinkIssueDocument(issueId, document.id),
            `Unlinked ${document.title}. The document itself is unchanged.`,
          )
        }
      />
      {error && <p role="alert">{error}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>
    </div>
  );
}

/**
 * Documents linked to a project directly, and documents its issues link to,
 * shown separately so it is clear which links belong to the project.
 */
export function ProjectDocuments({
  projectId,
  origin,
}: {
  projectId: string;
  origin: LinkOrigin;
}) {
  const { data, documents, busy, error, message, run } = useLinking(
    () => listProjectDocuments(projectId),
    projectId,
  );
  const inherited: InheritedDocument[] = data?.viaIssues ?? [];
  return (
    <div className="linked-documents">
      <DocumentLinks
        heading="Documents"
        linked={data?.direct ?? null}
        documents={documents}
        origin={origin}
        busy={busy}
        onLink={(documentId) =>
          run(
            () => linkProjectDocument(projectId, documentId),
            `Linked ${title(documents, documentId)}.`,
          )
        }
        onUnlink={(document) =>
          run(
            () => unlinkProjectDocument(projectId, document.id),
            `Unlinked ${document.title}. The document itself is unchanged.`,
          )
        }
      >
        {inherited.length > 0 && (
          <section aria-labelledby="project-inherited-documents">
            <h3 id="project-inherited-documents">From this project's issues</h3>
            <ul>
              {inherited.map((document) => (
                <li key={document.id}>
                  <Link to={documentPath(document.id)} state={origin}>
                    {document.title}
                  </Link>
                  <span className="document-inherited">
                    via{" "}
                    {document.issues.map((issue, index) => (
                      <span key={issue.id}>
                        {index > 0 && ", "}
                        <Link
                          to={`/issues/${issue.id}`}
                          aria-label={`ISS-${issue.number}: ${issue.title}`}
                        >
                          ISS-{issue.number}
                        </Link>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </DocumentLinks>
      {error && <p role="alert">{error}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>
    </div>
  );
}
