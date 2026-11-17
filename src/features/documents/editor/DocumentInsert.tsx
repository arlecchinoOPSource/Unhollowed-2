import { useEditorState, type Editor } from "@tiptap/react";
import { useState } from "react";
import { insertLocalImage } from "./DocumentImage";

export function DocumentInsert({
  editor,
  documentId,
}: {
  editor: Editor;
  documentId: string;
}) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inTable = useEditorState({
    editor,
    selector: ({ editor }) => editor.isActive("table"),
  });
  const operations = [
    ["Add row", () => editor.chain().focus().addRowAfter().run()],
    ["Delete row", () => editor.chain().focus().deleteRow().run()],
    ["Add column", () => editor.chain().focus().addColumnAfter().run()],
    ["Delete column", () => editor.chain().focus().deleteColumn().run()],
    ["Merge cells", () => editor.chain().focus().mergeCells().run()],
    ["Split cell", () => editor.chain().focus().splitCell().run()],
    ["Toggle header row", () => editor.chain().focus().toggleHeaderRow().run()],
    ["Delete table", () => editor.chain().focus().deleteTable().run()],
  ] as const;

  return (
    <details className="word-more document-insert">
      <summary>Insert and tables</summary>
      <div className="word-controls">
        <button
          type="button"
          disabled={inTable}
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run()
          }
        >
          Insert table
        </button>
        <label>
          Insert image
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={loading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              setError("");
              setLoading(true);
              void insertLocalImage(editor, documentId, file)
                .catch(() =>
                  setError(
                    "Could not insert this image. Choose a PNG, JPEG, GIF, or WebP up to 8 MiB.",
                  ),
                )
                .finally(() => setLoading(false));
            }}
          />
        </label>
        {loading && <span role="status">Reading image…</span>}
        {error && <p role="alert">{error}</p>}
        {inTable && (
          <>
            {operations.map(([label, run]) => (
              <button key={label} type="button" onClick={run}>
                {label}
              </button>
            ))}
            <label>
              Cell background
              <select
                defaultValue=""
                onChange={(event) =>
                  editor
                    .chain()
                    .focus()
                    .setCellAttribute("shade", event.target.value || null)
                    .run()
                }
              >
                <option value="">Default</option>
                <option value="neutral">Neutral</option>
                <option value="accent">Accent</option>
              </select>
            </label>
            <label>
              Cell alignment
              <select
                defaultValue=""
                onChange={(event) =>
                  editor
                    .chain()
                    .focus()
                    .setCellAttribute("alignment", event.target.value || null)
                    .run()
                }
              >
                <option value="">Default</option>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label>
              Cell border
              <select
                defaultValue=""
                onChange={(event) =>
                  editor
                    .chain()
                    .focus()
                    .setCellAttribute("border", event.target.value || null)
                    .run()
                }
              >
                <option value="">Standard</option>
                <option value="heavy">Heavy</option>
              </select>
            </label>
          </>
        )}
      </div>
    </details>
  );
}
