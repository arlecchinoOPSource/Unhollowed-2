import { useEffect, useRef, useState } from "react";
import {
  habitError,
  importHabits,
  pickHabitBackup,
  previewHabitImport,
  type HabitImportReport,
  type PickedBackup,
} from "../../database/habits";
import { fullDate } from "../calendar/monthGrid";

const plural = (count: number, one: string) =>
  `${count} ${count === 1 ? one : `${one}s`}`;

/**
 * Imports an Ember desktop backup. The file is chosen in the system dialog
 * and only read. A preview shows exactly what would be added; nothing changes
 * until the user confirms, and a preview that no longer matches is reviewed
 * again. See docs/HABITS.md, "Import sources".
 */
export function HabitImport({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<PickedBackup | null>(null);
  const [report, setReport] = useState<HabitImportReport | null>(null);
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
    try {
      await work();
    } catch (cause) {
      setError(habitError(cause));
    } finally {
      setBusy(false);
    }
  }

  const review = (picked: PickedBackup) =>
    run(async () => {
      setReport(await previewHabitImport(picked.content));
      setFile(picked);
    });

  const choose = () =>
    run(async () => {
      const picked = await pickHabitBackup();
      if (!picked) return; // Cancelled: keep whatever was on screen.
      setReport(await previewHabitImport(picked.content));
      setFile(picked);
    });

  const confirm = () =>
    run(async () => {
      if (!file || !report) return;
      const result = await importHabits(file.content, report.token);
      setReport(result);
      if (result.applied) onChanged();
    });

  const ready = report && !report.fatal && !report.applied;

  return (
    <dialog
      ref={dialog}
      className="project-dialog habit-manager"
      aria-labelledby="habit-import-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <h2 id="habit-import-title">Import from Ember</h2>
      <p>
        Choose a backup made by Ember desktop (a .json file). The file is only
        read and stays on this device. Habits are added after your current
        habits; nothing is merged or overwritten. An Ember website snapshot is
        not a backup: import it into Ember desktop first.
      </p>
      {error && <p role="alert">{error}</p>}

      {report?.fatal && (
        <div role="alert">
          <p>
            {file?.name} cannot be imported. {report.fatal}
          </p>
          {report.conflicts.length > 0 && (
            <ul aria-label="Conflicting habits">
              {report.conflicts.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
          {file && (
            <button
              type="button"
              className="action"
              disabled={busy}
              onClick={() => void review(file)}
            >
              Review again
            </button>
          )}
        </div>
      )}

      {report && !report.fatal && (
        <section aria-labelledby="habit-import-summary">
          <h3 id="habit-import-summary" role="status">
            {report.applied
              ? `Imported ${plural(report.habits.length, "habit")} and ${plural(report.completions, "completed day")}.`
              : `${file?.name}: ${plural(report.habits.length, "habit")} and ${plural(report.completions, "completed day")} will be added.`}
          </h3>
          {report.habits.length === 0 ? (
            <p>The backup has no habits.</p>
          ) : (
            <ul aria-label="Imported habits" className="habit-manager-list">
              {report.habits.map((habit) => (
                <li key={habit.name}>
                  <span className="habit-manager-name">
                    {habit.name}
                    <small>
                      {" "}
                      Starts {fullDate(habit.startDate)}
                      {habit.archivedOn
                        ? `, archived ${fullDate(habit.archivedOn)}`
                        : ""}
                      , {plural(habit.completions, "completed day")}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="habit-manager-actions">
        {ready && (
          <button
            type="button"
            className="action"
            disabled={busy || report.habits.length === 0}
            onClick={() => void confirm()}
          >
            {`Import ${plural(report.habits.length, "habit")}`}
          </button>
        )}
        {!report?.applied && (
          <button
            type="button"
            className="action"
            disabled={busy}
            onClick={() => void choose()}
          >
            {file ? "Choose another file…" : "Choose backup file…"}
          </button>
        )}
        <button type="button" className="action" onClick={close}>
          {report?.applied ? "Done" : "Cancel"}
        </button>
      </div>
    </dialog>
  );
}
