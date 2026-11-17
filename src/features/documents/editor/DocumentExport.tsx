import type { Editor } from "@tiptap/react";
import { useState } from "react";
import type { ExportFormat } from "./fileTransfer";

export function DocumentExport({
  editor,
  id,
  title,
}: {
  editor: Editor;
  id: string;
  title: string;
}) {
  const [format, setFormat] = useState<ExportFormat>("txt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { saveWritingFile } = await import("./fileTransfer");
      if (await saveWritingFile(editor, id, title, format))
        setMessage("Document file saved.");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not export this document.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="word-more">
      <summary>Export document</summary>
      <div className="word-controls">
        <label>
          File format
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
          >
            <option value="txt">Plain text</option>
            <option value="md">Markdown</option>
            <option value="html">HTML</option>
            <option value="docx">Word (.docx)</option>
          </select>
        </label>
        <button type="button" disabled={busy} onClick={() => void save()}>
          Save document file
        </button>
      </div>
      {(format === "md" || format === "txt") && (
        <p>Page layout, custom styling, and embedded images are omitted.</p>
      )}
      {format === "docx" && (
        <p>Review page breaks and advanced formatting in Word.</p>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
