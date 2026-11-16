import { useNavigate } from "react-router";
import {
  DocumentReferences,
  ReferencePicker,
  documentHref,
} from "./editor/DocumentReferences";
import {
  DocumentLayout,
  DocumentPageMode,
  PageSurface,
} from "./editor/DocumentLayout";
import { DocumentImage } from "./editor/DocumentImage";
import { DocumentInsert } from "./editor/DocumentInsert";
import { EditorContent } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRichTextEditor } from "../../components/editor/RichText";
import { DocumentToolbar } from "./editor/DocumentToolbar";
import { documentExtensions, readDocument } from "./editor/schema";
import {
  discardDraft,
  journalDraft,
  readDraft,
  saveDocumentDraft,
  waitForDocumentWrites,
  type Draft,
} from "./editor/drafts";
import { DocumentNavigation } from "./editor/DocumentNavigation";
import { RevisionHistory } from "./editor/RevisionHistory";
import "./editor/word.css";
import {
  getDocument,
  restoreDocumentRevision,
  type DocumentSummary,
  type WorkspaceDocument,
} from "../../database/documents";

const SAVE_DELAY_MS = 700;

type SaveState = "saved" | "saving" | "error";

const saveMessages: Record<SaveState, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  error: "Could not save. Retry or continue editing.",
};

export function DocumentEditor({
  id,
  onSaved,
}: {
  id: string;
  onSaved: (summary: DocumentSummary) => void;
}) {
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const [failure, setFailure] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let current = true;
    waitForDocumentWrites(id)
      .then(() => (current ? getDocument(id) : null))
      .then((loaded) => {
        if (!current || !loaded) return;
        try {
          readDocument(loaded.content);
          setDocument(loaded);
        } catch {
          setFailure(
            "This document uses an unsupported or damaged format. Its saved content has been preserved.",
          );
        }
      })
      .catch(() => current && setFailure("Could not open this document."));
    return () => {
      current = false;
    };
  }, [id]);

  if (failure) return <p role="alert">{failure}</p>;
  if (!document) return <p role="status">Opening document…</p>;
  return (
    <EditorBody
      key={generation}
      document={document}
      onSaved={onSaved}
      onRestored={(restored) => {
        onSaved(restored);
        setGeneration((n) => n + 1);
        try {
          readDocument(restored.content);
          setDocument(restored);
        } catch {
          setFailure(
            "This version uses an unsupported format. Your previous document is available in its saved history.",
          );
        }
      }}
    />
  );
}

function EditorBody({
  document,
  onSaved,
  onRestored,
}: {
  document: WorkspaceDocument;
  onSaved: (summary: DocumentSummary) => void;
  onRestored: (document: WorkspaceDocument) => void;
}) {
  const id = document.id;
  const navigate = useNavigate();
  const [updatedAt, setUpdatedAt] = useState(document.updatedAt);
  const [recovered, setRecovered] = useState(() => {
    const draft = readDraft(id);
    if (
      draft &&
      (draft.title.trim() || "Untitled") === document.title &&
      draft.content === document.content
    )
      return undefined;
    return draft;
  });
  const [title, setTitle] = useState(document.title);
  const [restoring, setRestoring] = useState(false);
  const [assetError, setAssetError] = useState("");
  const [pageMode, setPageMode] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const focusControl = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!focusMode) return;
    function escape(event: KeyboardEvent) {
      if (
        event.key !== "Escape" ||
        window.document.querySelector("dialog[open]")
      )
        return;
      event.preventDefault();
      setFocusMode(false);
      focusControl.current?.focus();
    }
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [focusMode]);
  const [journalFailed, setJournalFailed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const latest = useRef<Draft>({
    title: document.title,
    content: document.content,
  });
  const dirty = useRef(false);
  const timer = useRef<number>(undefined);
  const enqueued = useRef<Draft>(undefined);
  const notify = useRef(onSaved);
  useEffect(() => {
    notify.current = onSaved;
  }, [onSaved]);

  const editor = useRichTextEditor(
    "Document content",
    document.content,
    (content) => {
      latest.current = { ...latest.current, content };
      schedule();
    },
    documentExtensions.map((extension) =>
      extension.name === DocumentImage.name
        ? DocumentImage.configure({
            documentId: id,
            onImageError: () =>
              setAssetError(
                "Could not paste this image. Try inserting a local image under 8 MiB.",
              ),
          })
        : extension,
    ),
  );

  function save() {
    window.clearTimeout(timer.current);
    if (!dirty.current || enqueued.current === latest.current) return;
    const snapshot = latest.current;
    enqueued.current = snapshot;
    setSaveState("saving");
    void saveDocumentDraft(id, snapshot).then(
      (saved) => {
        setUpdatedAt(saved.updatedAt);
        notify.current(saved);
        if (latest.current === snapshot) {
          dirty.current = false;
          setJournalFailed(false);
          setSaveState("saved");
        }
      },
      () => {
        if (latest.current === snapshot) {
          enqueued.current = undefined;
          setSaveState("error");
        }
      },
    );
  }

  function schedule() {
    dirty.current = true;
    setJournalFailed(!journalDraft(id, latest.current));
    setSaveState("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, SAVE_DELAY_MS);
  }

  // Flush before another editor starts reading the same document.
  useLayoutEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (dirty.current) save();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function restore(revision: number) {
    if (dirty.current || recovered || restoring) return;
    setRestoring(true);
    editor?.setEditable(false, false);
    try {
      await waitForDocumentWrites(id);
      onRestored(await restoreDocumentRevision(id, revision));
    } finally {
      editor?.setEditable(!recovered, false);
      setRestoring(false);
    }
  }

  useEffect(() => {
    editor?.setEditable(!recovered && !restoring, false);
  }, [editor, recovered, restoring]);

  function resume() {
    if (!recovered || !editor) return;
    try {
      editor.commands.setContent(readDocument(recovered.content), {
        emitUpdate: false,
      });
      latest.current = recovered;
      setTitle(recovered.title);
      setRecovered(undefined);
      schedule();
    } catch {
      setSaveState("error");
    }
  }

  return (
    <DocumentPageMode value={pageMode}>
      <div className="document-editor" data-writing-focus={focusMode}>
        <h1 className="document-print-title">{title || "Untitled"}</h1>
        <div className="word-controls">
          <button
            type="button"
            ref={focusControl}
            aria-pressed={focusMode}
            onClick={() => setFocusMode(!focusMode)}
          >
            {focusMode ? "Exit focus mode" : "Focus mode"}
          </button>
        </div>
        <label className="visually-hidden" htmlFor="document-title">
          Document title
        </label>
        <input
          id="document-title"
          className="document-title"
          value={title}
          maxLength={200}
          disabled={Boolean(recovered) || restoring}
          onChange={(event) => {
            setTitle(event.target.value);
            latest.current = { ...latest.current, title: event.target.value };
            schedule();
          }}
        />
        {recovered && (
          <div className="word-controls">
            <p>
              Unsaved edits are available from an earlier session. Resume them
              or keep the saved version.
            </p>
            <button type="button" onClick={resume}>
              Resume unsaved edits
            </button>
            <button
              type="button"
              onClick={() => {
                discardDraft(id, recovered);
                setRecovered(undefined);
                setSaveState("saved");
              }}
            >
              Keep saved version
            </button>
          </div>
        )}
        {editor && !recovered && !restoring && (
          <>
            <DocumentToolbar editor={editor} />
            <DocumentInsert editor={editor} documentId={id} />
            <DocumentLayout editor={editor} setPageMode={setPageMode} />
            <DocumentNavigation editor={editor} />
          </>
        )}
        {assetError && <p role="alert">{assetError}</p>}
        {editor && (
          <PageSurface editor={editor}>
            <EditorContent
              editor={editor}
              className="editor"
              onClick={(event) => {
                const anchor =
                  event.target instanceof Element &&
                  event.target.closest<HTMLAnchorElement>(
                    "a[data-document-target]",
                  );
                if (!anchor || !anchor.dataset.documentTarget) return;
                event.preventDefault();
                navigate(documentHref(anchor.dataset.documentTarget));
              }}
            />
            {!recovered && !restoring && (
              <ReferencePicker editor={editor} id={id} />
            )}
          </PageSurface>
        )}
        {!focusMode && <DocumentReferences id={id} updatedAt={updatedAt} />}
        <p role="status" className="save-status">
          {restoring
            ? "Restoring version…"
            : recovered
              ? "Unsaved edit recovery available."
              : saveMessages[saveState]}
        </p>
        {journalFailed && (
          <p role="alert">
            Recovery storage is unavailable. Leave the editor open until the
            save finishes.
          </p>
        )}
        {saveState === "error" && !recovered && (
          <button className="action" type="button" onClick={save}>
            Retry save
          </button>
        )}
        <RevisionHistory
          id={id}
          disabled={saveState !== "saved" || Boolean(recovered) || restoring}
          restore={restore}
        />
      </div>
    </DocumentPageMode>
  );
}
