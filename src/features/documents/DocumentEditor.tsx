import { EditorContent } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { useRichTextEditor } from "../../components/editor/RichText";
import { DocumentToolbar } from "./editor/DocumentToolbar";
import { documentExtensions, readDocument } from "./editor/schema";
import "./editor/word.css";
import {
  getDocument,
  updateDocument,
  type DocumentSummary,
  type WorkspaceDocument,
} from "../../database/documents";

const SAVE_DELAY_MS = 700;

type SaveState = "saved" | "saving" | "error";

const saveMessages: Record<SaveState, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  error: "Could not save. Changes will be retried.",
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

  useEffect(() => {
    let current = true;
    getDocument(id)
      .then((loaded) => {
        if (!current) return;
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
  return <EditorBody document={document} onSaved={onSaved} />;
}

function EditorBody({
  document,
  onSaved,
}: {
  document: WorkspaceDocument;
  onSaved: (summary: DocumentSummary) => void;
}) {
  const [title, setTitle] = useState(document.title);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const latest = useRef({ title: document.title, content: document.content });
  const dirty = useRef(false);
  const timer = useRef<number>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const notify = useRef(onSaved);
  useEffect(() => {
    notify.current = onSaved;
  }, [onSaved]);

  const editor = useRichTextEditor(
    "Document content",
    document.content,
    (content) => {
      latest.current.content = content;
      schedule();
    },
    documentExtensions,
  );

  // Saves run one after another so an older write can never land last.
  function save() {
    queue.current = queue.current.then(async () => {
      if (!dirty.current) return;
      dirty.current = false;
      setSaveState("saving");
      try {
        const {
          id,
          title: savedTitle,
          updatedAt,
        } = await updateDocument(
          document.id,
          latest.current.title.trim() || "Untitled",
          latest.current.content,
        );
        notify.current({ id, title: savedTitle, updatedAt });
        setSaveState(dirty.current ? "saving" : "saved");
      } catch {
        dirty.current = true;
        setSaveState("error");
      }
    });
  }

  function schedule() {
    dirty.current = true;
    setSaveState("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, SAVE_DELAY_MS);
  }

  // Switching documents unmounts this component, so flush pending edits.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (dirty.current) save();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="document-editor">
      <label className="visually-hidden" htmlFor="document-title">
        Document title
      </label>
      <input
        id="document-title"
        className="document-title"
        value={title}
        maxLength={200}
        onChange={(event) => {
          setTitle(event.target.value);
          latest.current.title = event.target.value;
          schedule();
        }}
      />
      {editor && <DocumentToolbar editor={editor} />}
      <EditorContent editor={editor} className="editor" />
      <p role="status" className="save-status">
        {saveMessages[saveState]}
      </p>
    </div>
  );
}
