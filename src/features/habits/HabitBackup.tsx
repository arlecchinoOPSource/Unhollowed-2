import { useEffect, useRef, useState } from "react";
import {
  exportHabitBackup,
  exportHabitHistory,
  habitError,
  pickHabitRestore,
  previewHabitRestore,
  restoreHabits,
  undoHabitRestore,
  type HabitRestoreReport,
  type PickedBackup,
  type SavedHabits,
} from "../../database/habits";

const plural = (count: number, one: string) =>
  `${count} ${count === 1 ? one : `${one}s`}`;

/**
 * Local copies of habit data: a restorable backup, CSV and JSON history, and
 * restore with a preview, a private copy of what it replaces, and undo.
 * Everything uses the system file dialogs and stays on this device. See
 * docs/HABITS.md, "Backup and restore".
 */
export function HabitBackup({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<PickedBackup | null>(null);
  const [report, setReport] = useState<HabitRestoreReport | null>(null);
  // What the last applied restore was, so the button can offer the reverse.
  const [last, setLast] = useState<"restore" | "undo" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  function close() {
    dialog.current?.close();
    onClose();
  }

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError(habitError(cause));
    } finally {
      setBusy(false);
    }
  }

  const saved = (what: string, result: SavedHabits | null) =>
    setMessage(
      result
        ? `Saved ${what} with ${plural(result.completions, "completed day")} to ${result.path}.`
        : "Export canceled.",
    );

  const choose = () =>
    run(async () => {
      const picked = await pickHabitRestore();
      if (!picked) return; // Cancelled: keep whatever was on screen.
      setReport(await previewHabitRestore(picked.content));
      setFile(picked);
      setLast(null);
    });

  const review = () =>
    run(async () => {
      if (!file) return;
      setReport(await previewHabitRestore(file.content));
      setLast(null);
    });

  const confirm = () =>
    run(async () => {
      if (!file || !report) return;
      const result = await restoreHabits(file.content, report.token);
      setReport(result);
      if (result.applied) {
        setLast("restore");
        onChanged();
      }
    });

  const undo = () =>
    run(async () => {
      if (!report?.recovery) return;
      const result = await undoHabitRestore(report.recovery);
      setReport(result);
      if (result.applied) {
        setLast(last === "restore" ? "undo" : "restore");
        onChanged();
      }
    });

  const ready = report && !report.fatal && !report.applied;

  return (
    <dialog
      ref={dialog}
      className="project-dialog habit-manager"
      aria-labelledby="habit-backup-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <h2 id="habit-backup-title">Backup and restore</h2>
      <p role="status">{message}</p>
      {error && <p role="alert">{error}</p>}

      <h3>Save a copy</h3>
      <p>
        A backup keeps every habit in order, including archived and empty
        habits, and can be restored. History files list completed days only, for
        reading in other tools; they cannot be restored.
      </p>
      <div className="habit-manager-actions">
        <button
          type="button"
          className="action"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              saved("a backup of habits", await exportHabitBackup()),
            )
          }
        >
          Save backup…
        </button>
        <button
          type="button"
          className="action"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              saved("CSV history", await exportHabitHistory("csv")),
            )
          }
        >
          Export history as CSV…
        </button>
        <button
          type="button"
          className="action"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              saved("JSON history", await exportHabitHistory("json")),
            )
          }
        >
          Export history as JSON…
        </button>
      </div>

      <h3>Restore</h3>
      <p>
        Restoring replaces all habits in this workspace with the backup. A
        private copy of your current habits is saved first, and you can undo.
      </p>

      {report?.fatal && (
        <div role="alert">
          <p>
            {file?.name} cannot be restored. {report.fatal}
          </p>
          {file && (
            <button
              type="button"
              className="action"
              disabled={busy}
              onClick={() => void review()}
            >
              Review again
            </button>
          )}
        </div>
      )}

      {report && !report.fatal && (
        <section aria-labelledby="habit-restore-summary">
          <h4 id="habit-restore-summary">
            {report.applied
              ? last === "undo"
                ? `Restore undone. Your earlier habits are back: ${plural(report.habits, "habit")} and ${plural(report.completions, "completed day")}.`
                : `Restored ${plural(report.habits, "habit")} (${report.archived} archived) and ${plural(report.completions, "completed day")}.`
              : `${file?.name} has ${plural(report.habits, "habit")} (${report.archived} archived) and ${plural(report.completions, "completed day")}. Restoring replaces your ${plural(report.currentHabits, "habit")} and ${plural(report.currentCompletions, "completed day")}.`}
          </h4>
          {report.applied && report.recovery && (
            <p>
              The habits this replaced were saved privately as {report.recovery}
              .
            </p>
          )}
        </section>
      )}

      <div className="habit-manager-actions">
        {ready && (
          <button
            type="button"
            className="action danger"
            disabled={busy}
            onClick={() => void confirm()}
          >
            Replace my habits
          </button>
        )}
        {report?.applied && report.recovery && (
          <button
            type="button"
            className="action"
            disabled={busy}
            onClick={() => void undo()}
          >
            {last === "undo" ? "Redo restore" : "Undo restore"}
          </button>
        )}
        <button
          type="button"
          className="action"
          disabled={busy}
          onClick={() => void choose()}
        >
          {file ? "Choose another file…" : "Restore from backup…"}
        </button>
        <button type="button" className="action" onClick={close}>
          Done
        </button>
      </div>
    </dialog>
  );
}
