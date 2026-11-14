import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Heading2, Italic, List, ListOrdered } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    getDocument(id)
      .then((loaded) => current && setDocument(loaded))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [id]);

  if (failed) return <p role="alert">Could not open this document.</p>;
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

  const editor = useEditor({
    extensions: [StarterKit],
    content: JSON.parse(document.content),
    // Tiptap's injected <style> tag would be blocked by the app's CSP. The
    // equivalent rules live in workspace.css.
    injectCSS: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Document content",
      },
    },
    onUpdate: ({ editor: updated }) => {
      latest.current.content = JSON.stringify(updated.getJSON());
      schedule();
    },
  });

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

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      heading: current?.isActive("heading", { level: 2 }) ?? false,
      bulletList: current?.isActive("bulletList") ?? false,
      orderedList: current?.isActive("orderedList") ?? false,
    }),
  });

  const tools = [
    {
      label: "Bold",
      icon: Bold,
      pressed: active?.bold,
      run: () => editor?.chain().focus().toggleBold().run(),
    },
    {
      label: "Italic",
      icon: Italic,
      pressed: active?.italic,
      run: () => editor?.chain().focus().toggleItalic().run(),
    },
    {
      label: "Heading",
      icon: Heading2,
      pressed: active?.heading,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: "Bulleted list",
      icon: List,
      pressed: active?.bulletList,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      label: "Numbered list",
      icon: ListOrdered,
      pressed: active?.orderedList,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
  ];

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
      <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
        {tools.map(({ label, icon: Icon, pressed, run }) => (
          <button
            type="button"
            key={label}
            aria-label={label}
            title={label}
            aria-pressed={pressed}
            onClick={run}
          >
            <Icon size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
      <EditorContent editor={editor} className="editor" />
      <p role="status" className="save-status">
        {saveMessages[saveState]}
      </p>
    </div>
  );
}
