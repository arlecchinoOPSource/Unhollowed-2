import { ArrowLeft, FilePlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import {
  getDocumentUsage,
  type DocumentUsage,
} from "../../database/documentLinks";
import {
  createDocument,
  listDocuments,
  type DocumentSummary,
} from "../../database/documents";
import { isTauri } from "../../database/status";
import { DocumentEditor } from "./DocumentEditor";
import "./documentLinks.css";

export function Documents() {
  const desktop = isTauri();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  // The open document lives in the URL, so issues and projects can link to
  // it and the browser history returns to them.
  const [params, setParams] = useSearchParams();
  const activeId = params.get("doc");
  const location = useLocation();
  const origin = location.state as {
    from?: unknown;
    fromLabel?: unknown;
  } | null;
  function setActiveId(id: string) {
    setParams({ doc: id });
  }
  const [error, setError] = useState("");

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    listDocuments()
      .then((loaded) => current && setDocuments(loaded))
      .catch(
        () => current && setError("Could not read documents from storage."),
      );
    return () => {
      current = false;
    };
  }, [desktop]);

  const handleSaved = useCallback((saved: DocumentSummary) => {
    setDocuments((existing) => [
      saved,
      ...existing.filter(({ id }) => id !== saved.id),
    ]);
  }, []);

  async function create() {
    setError("");
    try {
      const created = await createDocument();
      handleSaved(created);
      setActiveId(created.id);
    } catch {
      setError("Could not create a document.");
    }
  }

  return (
    <>
      {typeof origin?.from === "string" &&
        typeof origin.fromLabel === "string" && (
          <Link className="issue-back" to={origin.from}>
            <ArrowLeft size={16} aria-hidden="true" /> Back to{" "}
            {origin.fromLabel}
          </Link>
        )}
      <h1>Documents</h1>
      <p>Write, organize, and connect your notes.</p>
      {!desktop ? (
        <p>Documents are stored locally in the desktop app.</p>
      ) : (
        <div className="documents">
          <section aria-labelledby="document-list-heading">
            <h2 id="document-list-heading">Your documents</h2>
            <button type="button" className="action" onClick={create}>
              <FilePlus size={15} aria-hidden="true" /> New document
            </button>
            {documents.length === 0 ? (
              <p>No documents yet.</p>
            ) : (
              <ul className="document-list">
                {documents.map(({ id, title }) => (
                  <li key={id}>
                    <button
                      type="button"
                      aria-current={id === activeId ? "true" : undefined}
                      onClick={() => setActiveId(id)}
                    >
                      {title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Editor">
            {activeId ? (
              <>
                <DocumentEditor
                  key={activeId}
                  id={activeId}
                  onSaved={handleSaved}
                />
                <DocumentUsagePanel key={`usage-${activeId}`} id={activeId} />
              </>
            ) : (
              <p>Select or create a document to start writing.</p>
            )}
          </section>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}

/** Issues and projects that link to the open document, to navigate back. */
function DocumentUsagePanel({ id }: { id: string }) {
  const [usage, setUsage] = useState<DocumentUsage | null>(null);
  useEffect(() => {
    let current = true;
    getDocumentUsage(id).then(
      (loaded) => {
        if (current) setUsage(loaded);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [id]);
  if (!usage || (usage.issues.length === 0 && usage.projects.length === 0))
    return null;
  return (
    <section className="document-usage" aria-labelledby="document-usage">
      <h2 id="document-usage">Linked from</h2>
      {usage.projects.length > 0 && (
        <ul aria-label="Projects">
          {usage.projects.map((project) => (
            <li key={project.id}>
              <Link to={`/projects/${project.id}`}>{project.name}</Link>
            </li>
          ))}
        </ul>
      )}
      {usage.issues.length > 0 && (
        <ul aria-label="Issues">
          {usage.issues.map((issue) => (
            <li key={issue.id}>
              <Link to={`/issues/${issue.id}`}>
                ISS-{issue.number}: {issue.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
