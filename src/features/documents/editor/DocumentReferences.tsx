import { invoke } from "@tauri-apps/api/core";
import { Mark, useEditorState, type Editor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  listDocuments,
  type DocumentSummary,
} from "../../../database/documents";

export function documentHref(id: string) {
  return `/documents?doc=${encodeURIComponent(id)}`;
}

export const DocumentReference = Mark.create({
  name: "documentReference",
  inclusive: false,
  excludes: "link",
  addAttributes() {
    return { targetId: { default: null, rendered: false } };
  },
  renderHTML({ mark }) {
    const id = mark.attrs.targetId;
    return typeof id === "string" && id.length
      ? ["a", { href: documentHref(id), "data-document-target": id }, 0]
      : ["span", 0];
  },
});

export function ReferencePicker({
  editor,
  id,
}: {
  editor: Editor;
  id: string;
}) {
  const match = useEditorState({
    editor,
    selector: ({ editor }) => {
      const { empty, $from } = editor.state.selection;
      if (!empty || !$from.parent.isTextblock) return null;
      const text = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
      const query = /\[\[([^\]\n]*)$/.exec(text);
      return query
        ? { text: query[1], from: $from.pos - query[0].length, to: $from.pos }
        : null;
    },
  });
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = useState<typeof match>(null);
  const open = match !== null;
  useEffect(() => {
    if (!open) return;
    let active = true;
    listDocuments()
      .then((items) => active && setDocuments(items))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [open]);
  if (
    !match ||
    (dismissed?.text === match.text && dismissed.from === match.from)
  )
    return null;
  const choices = documents
    .filter(
      (document) =>
        document.id !== id &&
        document.title.toLowerCase().includes(match.text.toLowerCase()),
    )
    .slice(0, 8);
  return (
    <div
      role="group"
      aria-label="Insert document link"
      className="editor-toolbar"
    >
      {choices.map((document) => (
        <button
          key={document.id}
          type="button"
          onClick={() => {
            editor
              .chain()
              .focus()
              .insertContentAt({ from: match.from, to: match.to }, [
                {
                  type: "text",
                  text: document.title,
                  marks: [
                    {
                      type: "documentReference",
                      attrs: { targetId: document.id },
                    },
                  ],
                },
                { type: "text", text: " " },
              ])
              .run();
          }}
        >
          {document.title}
        </button>
      ))}
      {!choices.length && (
        <span role="status">
          {failed ? "Could not load documents." : "No matching documents"}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setDismissed(match);
          editor.commands.focus();
        }}
      >
        Close link picker
      </button>
    </div>
  );
}

interface Reference {
  id: string;
  title: string;
  incoming: boolean;
}

export function DocumentReferences({
  id,
  updatedAt,
}: {
  id: string;
  updatedAt: string;
}) {
  const [references, setReferences] = useState<Reference[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    invoke<Reference[]>("list_document_references", { id })
      .then((items) => {
        if (!active) return;
        setReferences(items);
        setFailed(false);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [id, updatedAt]);
  return (
    <details>
      <summary>Document links</summary>
      {failed ? (
        <p role="alert">Could not load document links.</p>
      ) : (
        [false, true].map((incoming) => {
          const items = references.filter(
            (reference) => reference.incoming === incoming,
          );
          return (
            <section key={String(incoming)}>
              <h3>{incoming ? "Backlinks" : "Links to documents"}</h3>
              {items.length ? (
                <ul>
                  {items.map((item) => (
                    <li key={item.id}>
                      <Link to={documentHref(item.id)}>{item.title}</Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No links yet.</p>
              )}
            </section>
          );
        })
      )}
    </details>
  );
}
