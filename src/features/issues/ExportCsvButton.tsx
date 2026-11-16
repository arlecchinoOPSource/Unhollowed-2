import { FileDown } from "lucide-react";
import { useState } from "react";
import type { IssueQuery } from "../../database/issues";
import { exportIssuesCsv, portabilityError } from "../../database/portability";

/**
 * Saves the issues the current filters match as CSV. The query is the one
 * the list uses, so the file follows search, filters, and sort, but includes
 * every page rather than only the issues loaded so far.
 */
export function ExportCsvButton({ query }: { query: IssueQuery }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const saved = await exportIssuesCsv(query);
      setMessage(
        saved
          ? `Exported ${saved.records} ${saved.records === 1 ? "issue" : "issues"} to ${saved.path}.`
          : "Export canceled.",
      );
    } catch (cause) {
      setError(portabilityError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="issue-export">
      <button type="button" aria-disabled={busy} onClick={() => void save()}>
        <FileDown size={15} aria-hidden="true" /> Export CSV
      </button>
      {error && <p role="alert">{error}</p>}
      <p role="status" className="issue-export-message">
        {message}
      </p>
    </div>
  );
}
