import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  archiveHabit,
  deleteHabit,
  getHabitDeletionImpact,
  habitError,
  linkHabitRoutine,
  listHabitHistory,
  listHabitRoutines,
  listHabits,
  listRoutineChoices,
  renameHabit,
  reorderHabits,
  restoreHabit,
  routineLabel,
  type Routine,
  unlinkHabitRoutine,
  type Habit,
  type HabitDeletionImpact,
} from "../../database/habits";
import { fullDate } from "../calendar/monthGrid";

interface Review {
  impact: HabitDeletionImpact;
  /** Set when the habit changed after the user first reviewed it. */
  notice: string;
}

/**
 * Habit management: rename, reorder, archive, restore, and delete after a
 * reviewed preview. Every change reloads the list from storage and tells the
 * page to refresh its grid. See docs/HABITS.md.
 */
export function HabitManager({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [habits, setHabits] = useState<Habit[] | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [review, setReview] = useState<(Review & { habit: Habit }) | null>(
    null,
  );
  const [routines, setRoutines] = useState<
    Record<string, Routine[] | "failed">
  >({});
  const [choices, setChoices] = useState<Routine[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Record<string, string[] | "failed">>(
    {},
  );
  // Selectors to try, in order, once the list has re-rendered after a change.
  const focusAfter = useRef<string[]>([]);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    listHabits()
      .then(setHabits)
      .catch((cause) => {
        setHabits([]);
        setError(habitError(cause));
      });
  }, []);

  useEffect(() => {
    for (const selector of focusAfter.current) {
      const target = dialog.current?.querySelector<HTMLElement>(selector);
      if (target) {
        target.focus();
        break;
      }
    }
    focusAfter.current = [];
  });

  function close() {
    dialog.current?.close();
    onClose();
  }

  const list = habits ?? [];
  const active = list.filter((habit) => !habit.archivedOn);
  const archived = list.filter((habit) => habit.archivedOn);
  const row = (habit: Habit, control: string) =>
    `[data-habit="${habit.id}"] ${control}`;

  /** Runs one change, then reloads storage's truth. Failures keep all data. */
  async function change(
    action: () => Promise<unknown>,
    message: string,
    focus: string[],
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await action();
      focusAfter.current = [...focus, "[data-archived-heading]"];
      setHabits(await listHabits());
      setStatus(message);
      onChanged();
      return true;
    } catch (cause) {
      setError(habitError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function move(habit: Habit, step: -1 | 1) {
    // Swap with the nearest active neighbor; archived habits keep their places.
    const neighbor =
      active[active.findIndex(({ id }) => id === habit.id) + step];
    if (!neighbor) return;
    const ids = list.map(({ id }) => id);
    const from = ids.indexOf(habit.id);
    const to = ids.indexOf(neighbor.id);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void change(
      () => reorderHabits(ids),
      `Moved ${habit.name} ${step < 0 ? "up" : "down"}.`,
      [
        row(habit, `[data-move="${step}"]:not(:disabled)`),
        row(habit, `[data-move="${-step}"]:not(:disabled)`),
      ],
    );
  }

  async function rename(event: FormEvent<HTMLFormElement>, habit: Habit) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    await change(
      async () => {
        await renameHabit(habit.id, name);
        // Leave edit mode first so the Rename button exists when focus returns.
        setRenaming(null);
      },
      `Renamed to ${name}.`,
      [row(habit, "[data-rename]")],
    );
  }

  async function startDelete(habit: Habit) {
    setError("");
    try {
      setReview({
        habit,
        impact: await getHabitDeletionImpact(habit.id),
        notice: "",
      });
    } catch (cause) {
      setError(habitError(cause));
    }
  }

  async function confirmDelete() {
    if (!review || busy) return;
    const { habit, impact } = review;
    setBusy(true);
    setError("");
    try {
      await deleteHabit(habit.id, impact.revision);
      setReview(null);
      focusAfter.current = ["[data-archived-heading]"];
      setHabits(await listHabits());
      setStatus(`Deleted ${habit.name}.`);
      onChanged();
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? cause.code
          : null;
      if (code === "changed" || code === "not_archived") {
        // Re-fetch so the user reviews what would be lost now.
        try {
          const latest = await getHabitDeletionImpact(habit.id);
          setReview({ habit, impact: latest, notice: habitError(cause) });
          setHabits(await listHabits());
        } catch (again) {
          setReview(null);
          setError(habitError(again));
        }
      } else {
        setError(habitError(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  async function showRoutines(habit: Habit, open: boolean) {
    if (!open) return;
    try {
      const [mine, all] = await Promise.all([
        listHabitRoutines(habit.id),
        listRoutineChoices(),
      ]);
      setRoutines((current) => ({ ...current, [habit.id]: mine }));
      setChoices(all);
    } catch {
      setRoutines((current) => ({ ...current, [habit.id]: "failed" }));
    }
  }

  function changeRoutine(
    habit: Habit,
    action: () => Promise<Routine[]>,
    message: string,
  ) {
    void change(
      async () => {
        const mine = await action();
        setRoutines((current) => ({ ...current, [habit.id]: mine }));
      },
      message,
      [row(habit, "[data-routine-select]"), row(habit, "[data-rename]")],
    );
  }

  async function showHistory(habit: Habit, open: boolean) {
    if (!open || history[habit.id]) return;
    try {
      const dates = await listHabitHistory(habit.id);
      setHistory((current) => ({ ...current, [habit.id]: dates }));
    } catch {
      setHistory((current) => ({ ...current, [habit.id]: "failed" }));
    }
  }

  return (
    <dialog
      ref={dialog}
      className="project-dialog habit-manager"
      aria-labelledby="habit-manager-title"
      onCancel={(event) => {
        event.preventDefault();
        if (busy) return;
        if (review) setReview(null);
        else if (renaming) {
          focusAfter.current = [`[data-habit="${renaming}"] [data-rename]`];
          setRenaming(null);
        } else close();
      }}
    >
      <h2 id="habit-manager-title">Manage habits</h2>
      <p role="status" className="visually-hidden">
        {status}
      </p>
      {error && <p role="alert">{error}</p>}
      {habits === null && <p>Loading habits…</p>}

      {review && (
        <section aria-labelledby="habit-delete-title">
          <h3 id="habit-delete-title" tabIndex={-1} ref={(el) => el?.focus()}>
            Delete {review.impact.name} permanently?
          </h3>
          {review.notice && <p role="alert">{review.notice}</p>}
          <p>
            {review.impact.completions === 0
              ? "This habit has no completed days."
              : `This removes ${review.impact.completions} completed ${review.impact.completions === 1 ? "day" : "days"}, from ${fullDate(review.impact.firstDate!)} to ${fullDate(review.impact.lastDate!)}.`}{" "}
            This cannot be undone.
          </p>
          <div className="habit-manager-actions">
            <button
              type="button"
              className="action danger"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              Delete permanently
            </button>
            <button
              type="button"
              className="action"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {habits && !review && (
        <>
          <h3>Active habits</h3>
          {active.length === 0 ? (
            <p>No active habits. Add one from the habits page.</p>
          ) : (
            <ul className="habit-manager-list" aria-label="Active habits">
              {active.map((habit, position) => (
                <li key={habit.id} data-habit={habit.id}>
                  {renaming === habit.id ? (
                    <form
                      aria-label={`Rename ${habit.name}`}
                      onSubmit={(event) => void rename(event, habit)}
                    >
                      <label>
                        <span className="visually-hidden">
                          New name for {habit.name}
                        </span>
                        <input
                          name="name"
                          required
                          maxLength={60}
                          defaultValue={habit.name}
                          ref={(el) => {
                            el?.focus();
                            el?.select();
                          }}
                        />
                      </label>
                      <button className="action" type="submit" disabled={busy}>
                        Save name
                      </button>
                      <button
                        type="button"
                        className="action"
                        onClick={() => {
                          focusAfter.current = [row(habit, "[data-rename]")];
                          setRenaming(null);
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <span className="habit-manager-name">{habit.name}</span>
                      <button
                        type="button"
                        data-rename
                        aria-label={`Rename ${habit.name}`}
                        disabled={busy}
                        onClick={() => setRenaming(habit.id)}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        data-move="-1"
                        aria-label={`Move up, ${habit.name}`}
                        disabled={busy || position === 0}
                        onClick={() => move(habit, -1)}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        data-move="1"
                        aria-label={`Move down, ${habit.name}`}
                        disabled={busy || position === active.length - 1}
                        onClick={() => move(habit, 1)}
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        aria-label={`Archive ${habit.name}`}
                        disabled={busy}
                        onClick={() =>
                          void change(
                            () => archiveHabit(habit.id),
                            `Archived ${habit.name}. Its history is kept.`,
                            [row(habit, "[data-restore]")],
                          )
                        }
                      >
                        Archive
                      </button>
                      <details
                        className="habit-routines"
                        onToggle={(event) =>
                          void showRoutines(habit, event.currentTarget.open)
                        }
                      >
                        <summary>Routines of {habit.name}</summary>
                        <RoutineEditor
                          habit={habit}
                          mine={routines[habit.id]}
                          choices={choices}
                          picked={picked[habit.id] ?? ""}
                          busy={busy}
                          onPick={(id) =>
                            setPicked((current) => ({
                              ...current,
                              [habit.id]: id,
                            }))
                          }
                          onLink={() =>
                            changeRoutine(
                              habit,
                              () =>
                                linkHabitRoutine(habit.id, picked[habit.id]),
                              `Linked ${habit.name} to a routine.`,
                            )
                          }
                          onUnlink={(routine) =>
                            changeRoutine(
                              habit,
                              () =>
                                unlinkHabitRoutine(habit.id, routine.eventId),
                              `Unlinked ${routine.title} from ${habit.name}.`,
                            )
                          }
                        />
                      </details>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h3 tabIndex={-1} data-archived-heading>
            Archived habits
          </h3>
          {archived.length === 0 ? (
            <p>No archived habits.</p>
          ) : (
            <ul className="habit-manager-list" aria-label="Archived habits">
              {archived.map((habit) => {
                const days = history[habit.id];
                return (
                  <li key={habit.id} data-habit={habit.id}>
                    <span className="habit-manager-name">
                      {habit.name}
                      <small> Archived {fullDate(habit.archivedOn!)}</small>
                    </span>
                    <button
                      type="button"
                      data-restore
                      aria-label={`Restore ${habit.name}`}
                      disabled={busy}
                      onClick={() =>
                        void change(
                          () => restoreHabit(habit.id),
                          `Restored ${habit.name}.`,
                          [row(habit, "[data-rename]")],
                        )
                      }
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${habit.name} permanently`}
                      disabled={busy}
                      onClick={() => void startDelete(habit)}
                    >
                      Delete…
                    </button>
                    <details
                      onToggle={(event) =>
                        void showHistory(habit, event.currentTarget.open)
                      }
                    >
                      <summary>History of {habit.name}</summary>
                      {days === undefined && <p>Loading…</p>}
                      {days === "failed" && (
                        <p role="alert">Could not load this history.</p>
                      )}
                      {Array.isArray(days) &&
                        (days.length === 0 ? (
                          <p>No completed days.</p>
                        ) : (
                          <ul aria-label={`Completed days, ${habit.name}`}>
                            {days.map((date) => (
                              <li key={date}>{fullDate(date)}</li>
                            ))}
                          </ul>
                        ))}
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="habit-manager-actions">
            <button type="button" className="action" onClick={close}>
              Done
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

/** The routines of one habit: linked events, and a picker for more. */
function RoutineEditor({
  habit,
  mine,
  choices,
  picked,
  busy,
  onPick,
  onLink,
  onUnlink,
}: {
  habit: Habit;
  mine: Routine[] | "failed" | undefined;
  choices: Routine[];
  picked: string;
  busy: boolean;
  onPick: (eventId: string) => void;
  onLink: () => void;
  onUnlink: (routine: Routine) => void;
}) {
  if (mine === undefined) return <p>Loading…</p>;
  if (mine === "failed") return <p role="alert">Could not load routines.</p>;
  const free = choices.filter(
    (choice) => !mine.some((linked) => linked.eventId === choice.eventId),
  );
  return (
    <>
      {mine.length === 0 ? (
        <p>No repeating event linked.</p>
      ) : (
        <ul aria-label={`Routines of ${habit.name}`}>
          {mine.map((routine) => (
            <li key={routine.eventId}>
              {routine.title} <small>({routineLabel(routine)})</small>{" "}
              <Link to={`/calendar?date=${routine.startDate}`}>
                Open {routine.title} in the calendar
              </Link>{" "}
              <button
                type="button"
                disabled={busy}
                aria-label={`Unlink ${routine.title} from ${habit.name}`}
                onClick={() => onUnlink(routine)}
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
      {free.length === 0 ? (
        <p>
          {choices.length === 0
            ? "No repeating events yet. Create one in the calendar."
            : "Every repeating event is already linked."}
        </p>
      ) : (
        <p>
          <label>
            Link {habit.name} to a repeating event{" "}
            <select
              data-routine-select
              value={picked}
              onChange={(event) => onPick(event.target.value)}
            >
              <option value="">Choose an event</option>
              {free.map((choice) => (
                <option key={choice.eventId} value={choice.eventId}>
                  {choice.title} ({routineLabel(choice)})
                </option>
              ))}
            </select>
          </label>{" "}
          <button type="button" disabled={busy || !picked} onClick={onLink}>
            Link routine
          </button>
        </p>
      )}
    </>
  );
}
