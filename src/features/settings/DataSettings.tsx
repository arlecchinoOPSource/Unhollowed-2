import { Download, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import {
  exportProjectData,
  importProjectData,
  MAX_IMPORT_BYTES,
  portabilityError,
  previewImport,
  type ImportReport,
} from "../../database/portability";
import "./settings.css";

/** How many renumbered keys the report lists before summarizing the rest. */
const RENUMBERED_SHOWN = 50;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** The lines of an import report, shared by the preview and the result. */
function ReportDetails({ report }: { report: ImportReport }) {
  const lines = [
    plural(report.projects, "project"),
    plural(report.issues, "issue"),
    plural(report.milestones, "milestone"),
    `${plural(report.missions, "mission")} and ${plural(report.objectives, "objective")}`,
    plural(report.relationships, "relationship"),
    plural(report.labelsCreated, "new label"),
  ];
  const shown = report.renumbered.slice(0, RENUMBERED_SHOWN);
  return (
    <>
      <ul className="import-report">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {report.labelsReused.length > 0 && (
          <li>Uses existing labels: {report.labelsReused.join(", ")}</li>
        )}
        {report.skippedLabelLinks > 0 && (
          <li>
            Skips {plural(report.skippedLabelLinks, "link")} to labels that are
            archived here
          </li>
        )}
        {report.completionRepaired > 0 && (
          <li>
            Sets a completion time on{" "}
            {plural(report.completionRepaired, "done issue")} that had none
          </li>
        )}
      </ul>
      {shown.length > 0 && (
        <details className="import-renumbered">
          <summary>New issue keys</summary>
          <ul>
            {shown.map(([from, to]) => (
              <li key={from}>
                {from} → {to}
              </li>
            ))}
          </ul>
          {report.renumbered.length > shown.length && (
            <p>…and {report.renumbered.length - shown.length} more.</p>
          )}
        </details>
      )}
    </>
  );
}

/**
 * Exports every project and issue to a JSON file, and imports such a file
 * as copies after showing what the import will do. The file is read here
 * and sent as text, so the app never needs file system permissions.
 */
export function DataSettings() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{
    name: string;
    content: string;
    report: ImportReport;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError(portabilityError(cause));
    } finally {
      setBusy(false);
    }
  }

  function clearFile() {
    setPending(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  function exportData() {
    void run(async () => {
      const saved = await exportProjectData();
      setMessage(
        saved
          ? `Exported ${plural(saved.records, "project and issue", "projects and issues")} to ${saved.path}.`
          : "Export canceled.",
      );
    });
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setPending(null);
    if (!file) return;
    void run(async () => {
      if (file.size > MAX_IMPORT_BYTES) {
        clearFile();
        setError("This file is larger than 50 MB, so it was not imported.");
        return;
      }
      const content = await file.text();
      try {
        const report = await previewImport(content);
        setPending({ name: file.name, content, report });
        requestAnimationFrame(() => importButton.current?.focus());
      } catch (cause) {
        clearFile();
        throw cause;
      }
    });
  }

  function confirmImport() {
    if (!pending) return;
    void run(async () => {
      const report = await importProjectData(pending.content);
      clearFile();
      setMessage(
        `Imported ${plural(report.projects, "project")} and ${plural(report.issues, "issue")} from ${pending.name}.`,
      );
    });
  }

  return (
    <section aria-labelledby="data-heading" className="settings-section">
      <h2 id="data-heading">Data</h2>
      <p>
        Export every project and issue to a JSON file, including archived
        issues. Documents, saved views, and repeat schedules are not included.
      </p>
      <button
        type="button"
        className="action"
        aria-disabled={busy}
        onClick={exportData}
      >
        <Download size={16} aria-hidden="true" /> Export projects
      </button>

      <h3>Import</h3>
      <p>
        Importing adds copies with new issue numbers. Nothing in this workspace
        is changed or replaced, and you can review the import first.
      </p>
      <div className="data-import">
        <label htmlFor="import-file">
          <Upload size={16} aria-hidden="true" /> Choose an export file
        </label>
        <input
          id="import-file"
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          disabled={busy && !pending}
          onChange={chooseFile}
        />
      </div>

      {pending && (
        <div
          className="import-preview"
          role="group"
          aria-labelledby="import-preview-heading"
        >
          <h3 id="import-preview-heading">Importing {pending.name} will add</h3>
          <ReportDetails report={pending.report} />
          <div className="import-actions">
            <button
              type="button"
              className="action"
              ref={importButton}
              aria-disabled={busy}
              onClick={confirmImport}
            >
              Import
            </button>
            <button
              type="button"
              className="import-cancel"
              onClick={() => {
                clearFile();
                setMessage("Import canceled.");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="data-error">
          {error}
        </p>
      )}
      <p role="status" className="data-message">
        {message}
      </p>
    </section>
  );
}
