import { useEffect, useState } from "react";
import {
  listCalendars,
  schedulingError,
  type Calendar,
} from "../../database/calendars";
import { deviceZone } from "../../database/events";
import {
  exportCalendarIcs,
  importIcs,
  pickIcsFile,
  previewIcsImport,
  type IcsReport,
} from "../../database/ics";

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Import and export of iCalendar (.ics) files through the system's file
 * dialogs. An import is previewed first with the same code that applies it,
 * so the preview lists exactly what will be added, what is already there,
 * and what cannot be imported and why.
 */
export function IcsTransfer({ onChanged }: { onChanged: () => void }) {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [calendarId, setCalendarId] = useState("");
  const [file, setFile] = useState<{ name: string; content: string } | null>(
    null,
  );
  const [report, setReport] = useState<IcsReport | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    listCalendars().then(
      (loaded) => current && setCalendars(loaded.filter((c) => !c.archivedAt)),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError(schedulingError(cause));
    } finally {
      setBusy(false);
    }
  }

  const chosen = calendarId || null;

  return (
    <details className="calendar-preferences">
      <summary>Import and export</summary>
      <p>
        Calendar files (.ics) move events between calendar apps. Files stay on
        this device. Only events are exchanged, and anything a file holds that
        this app does not support is listed before you import.
      </p>
      <div>
        <button
          type="button"
          className="action"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const saved = await exportCalendarIcs();
              setMessage(
                saved
                  ? `Saved ${plural(saved.events, "event")} to ${saved.path}.`
                  : "Export canceled.",
              );
            })
          }
        >
          Export calendar…
        </button>
      </div>
      <div>
        <label>
          Import into{" "}
          <select
            value={calendarId}
            onChange={(event) => {
              setCalendarId(event.target.value);
              setReport(null);
            }}
          >
            <option value="">Default calendar</option>
            {calendars.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>{" "}
        <button
          type="button"
          className="action"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const picked = await pickIcsFile();
              if (!picked) return;
              setFile(picked);
              setReport(
                await previewIcsImport(picked.content, chosen, deviceZone()),
              );
            })
          }
        >
          Choose a file to import…
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <p role="status">{message}</p>
      {file && report && (
        <section aria-label={`Import preview for ${file.name}`}>
          <h3>{file.name}</h3>
          {report.fatal ? (
            <p role="alert">{report.fatal}</p>
          ) : (
            <>
              <p>
                {report.applied
                  ? `Imported ${plural(report.imported.length, "event")}.`
                  : `Ready to import ${plural(report.imported.length, "event")} of ${plural(report.found, "event")} in the file.`}
                {report.duplicates.length > 0 &&
                  ` ${plural(report.duplicates.length, "event")} already in your calendar ${report.duplicates.length === 1 ? "is" : "are"} kept as ${report.duplicates.length === 1 ? "it is" : "they are"}.`}
              </p>
              {report.imported.length > 0 && (
                <ul aria-label="Events to import">
                  {report.imported.map((entry) => (
                    <li key={entry.uid}>
                      {entry.title}
                      {entry.recurring ? " (repeats)" : ""}
                      {entry.exceptions > 0
                        ? `, ${plural(entry.exceptions, "changed or canceled occurrence")}`
                        : ""}
                    </li>
                  ))}
                </ul>
              )}
              {report.skipped.length > 0 && (
                <>
                  <h4>Not imported</h4>
                  <ul aria-label="Events not imported">
                    {report.skipped.map((issue, index) => (
                      <li key={`${issue.uid}-${index}`}>
                        {issue.title || "Untitled event"}: {issue.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {report.warnings.length > 0 && (
                <>
                  <h4>Notes</h4>
                  <ul aria-label="Import notes">
                    {report.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </>
              )}
              {!report.applied && (
                <button
                  type="button"
                  className="action"
                  disabled={busy || report.imported.length === 0}
                  onClick={() =>
                    void run(async () => {
                      const done = await importIcs(
                        file.content,
                        chosen,
                        deviceZone(),
                      );
                      setReport(done);
                      setMessage(
                        `Imported ${plural(done.imported.length, "event")}.`,
                      );
                      onChanged();
                    })
                  }
                >
                  Import {plural(report.imported.length, "event")}
                </button>
              )}
            </>
          )}
        </section>
      )}
    </details>
  );
}
