import { ArrowLeft, FilePlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import {
  getDocumentUsage,
  type DocumentUsage,
} from "../../database/documentLinks";
import type { DocumentSummary } from "../../database/documents";
import {
  addLibraryDocument,
  createFolder,
  duplicateDocument,
  loadLibrary,
  updateLibraryDocument,
  type Folder,
  type LibraryDocument,
} from "../../database/documentLibrary";
import {
  LibraryControls,
  folderPath,
  templateBody,
  templates,
} from "./LibraryControls";
import { readDraft, waitForDocumentWrites } from "./editor/drafts";
import { isTauri } from "../../database/status";
import { DocumentEditor } from "./DocumentEditor";
import "./documentLinks.css";

export function Documents() {
  const desktop = isTauri();
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState("all");
  const [view, setView] = useState("active");
  const [sort, setSort] = useState("updated");
  const [template, setTemplate] =
    useState<keyof typeof templates>("Blank document");
  const [busy, setBusy] = useState(false);
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
    loadLibrary()
      .then((loaded) => {
        if (!current) return;
        setDocuments(loaded.documents);
        setFolders(loaded.folders);
      })
      .catch(
        () => current && setError("Could not read documents from storage."),
      );
    return () => {
      current = false;
    };
  }, [desktop]);

  const handleSaved = useCallback((saved: DocumentSummary) => {
    setDocuments((existing) =>
      existing.map((entry) =>
        entry.id === saved.id
          ? { ...entry, title: saved.title, updatedAt: saved.updatedAt }
          : entry,
      ),
    );
  }, []);

  function upsert(saved: LibraryDocument) {
    setDocuments((existing) => [
      saved,
      ...existing.filter(({ id }) => id !== saved.id),
    ]);
  }

  function select(id: string) {
    setActiveId(id);
    void updateLibraryDocument(id, { kind: "open" }).then(
      (item) => {
        setDocuments((entries) =>
          entries.map((entry) =>
            entry.id === item.id
              ? { ...entry, openedAt: item.openedAt }
              : entry,
          ),
        );
      },
      () => undefined,
    );
  }

  async function run(operation: () => Promise<void>) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await operation();
      return true;
    } catch {
      setError("Could not update the document library. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const selected = documents.find(({ id }) => id === activeId);
  const query = search.trim().toLocaleLowerCase();
  const visible = documents
    .filter(
      (item) =>
        Boolean(item.archivedAt) === (view === "archived") &&
        (view !== "favorites" || item.favorite) &&
        (view !== "recent" || item.openedAt) &&
        (folder === "all" || item.folderId === (folder || null)) &&
        item.title.toLocaleLowerCase().includes(query),
    )
    .sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "created"
          ? b.createdAt.localeCompare(a.createdAt)
          : view === "recent"
            ? (b.openedAt ?? "").localeCompare(a.openedAt ?? "")
            : b.updatedAt.localeCompare(a.updatedAt),
    );

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
            <div className="word-controls">
              <label>
                Template
                <select
                  value={template}
                  onChange={(event) =>
                    setTemplate(event.target.value as keyof typeof templates)
                  }
                >
                  {Object.keys(templates).map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                Search documents
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label>
                Show documents
                <select
                  value={view}
                  onChange={(event) => setView(event.target.value)}
                >
                  <option value="active">Active</option>
                  <option value="favorites">Favorites</option>
                  <option value="recent">Recent</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
              <label>
                Folder filter
                <select
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                >
                  <option value="all">All folders</option>
                  <option value="">Top level</option>
                  {folders.map(({ id }) => (
                    <option key={id} value={id}>
                      {folderPath(id, folders)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Sort documents
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="updated">
                    {view === "recent" ? "Last opened" : "Last updated"}
                  </option>
                  <option value="created">Recently created</option>
                  <option value="title">Title</option>
                </select>
              </label>
            </div>
            <button
              type="button"
              className="action"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const created = await addLibraryDocument(
                    template === "Blank document" ? "Untitled" : template,
                    templateBody(template),
                    folder === "all" ? null : folder || null,
                  );
                  upsert(created);
                  setView("active");
                  setSearch("");
                  setActiveId(created.id);
                })
              }
            >
              <FilePlus size={15} aria-hidden="true" /> New document
            </button>
            <LibraryControls
              folders={folders}
              selected={selected}
              busy={busy}
              addFolder={(name, parent) =>
                run(async () => {
                  const created = await createFolder(name, parent);
                  setFolders((items) => [...items, created]);
                })
              }
              update={(input) => {
                if (selected)
                  void run(async () =>
                    upsert(await updateLibraryDocument(selected.id, input)),
                  );
              }}
              duplicate={() => {
                if (selected)
                  void run(async () => {
                    await waitForDocumentWrites(selected.id);
                    if (readDraft(selected.id)) {
                      setError(
                        "Wait for the document to save or resolve its recovered draft before duplicating.",
                      );
                      return;
                    }
                    const created = await duplicateDocument(selected.id);
                    upsert(created);
                    setView("active");
                    setSearch("");
                    setActiveId(created.id);
                  });
              }}
            />
            {visible.length === 0 ? (
              <p>
                {documents.length
                  ? "No documents match this view."
                  : "No documents yet."}
              </p>
            ) : (
              <ul className="document-list">
                {visible.map(({ id, title }) => (
                  <li key={id}>
                    <button
                      type="button"
                      aria-current={id === activeId ? "true" : undefined}
                      onClick={() => select(id)}
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
