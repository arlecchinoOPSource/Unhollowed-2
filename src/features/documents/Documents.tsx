import { FilePlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  createDocument,
  listDocuments,
  type DocumentSummary,
} from "../../database/documents";
import { isTauri } from "../../database/status";
import { DocumentEditor } from "./DocumentEditor";

export function Documents() {
  const desktop = isTauri();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
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
              <DocumentEditor
                key={activeId}
                id={activeId}
                onSaved={handleSaved}
              />
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
