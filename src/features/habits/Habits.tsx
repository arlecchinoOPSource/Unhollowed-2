import { ChevronLeft, ChevronRight, CircleCheck } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  createHabit,
  getHabitMonth,
  habitError,
  listHabits,
  setHabitCompletion,
  type Habit,
  type HabitMonth,
} from "../../database/habits";
import { isTauri } from "../../database/status";
import {
  fullDate,
  monthOf,
  monthTitle,
  shiftMonth,
} from "../calendar/monthGrid";
import { shortcutAllowed } from "../issues/issueKeyboard";
import { localDate, msUntilNextLocalMidnight } from "../today/dates";
import { cellKey, HabitGrid } from "./HabitGrid";
import { FIRST_MONTH, LAST_MONTH, monthDates } from "./gridRules";
import "./habits.css";

interface Failure {
  habit: Habit;
  date: string;
  done: boolean;
  message: string;
}

const monthNames = Array.from({ length: 12 }, (_, index) =>
  new Date(2026, index, 1).toLocaleDateString(undefined, { month: "long" }),
);

/**
 * Ember's monthly checkbox grid in the workspace shell. Each click saves the
 * wanted state; a cell keeps at most one save in flight and sends the latest
 * wanted state when it returns, so the stored value always ends as the last
 * click. See docs/HABITS.md.
 */
export function Habits() {
  const desktop = isTauri();
  const [month, setMonth] = useState(() => monthOf(localDate(new Date())));
  const [data, setData] = useState<HabitMonth | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const wanted = useRef(new Map<string, boolean>());
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [failure, setFailure] = useState<Failure | null>(null);
  const [status, setStatus] = useState("");
  const [addError, setAddError] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    const [year, index] = month.split("-").map(Number);
    Promise.all([getHabitMonth(year, index), listHabits()])
      .then(([result, habits]) => {
        if (!live) return;
        setData(result);
        setTotal(habits.length);
        setDone(
          new Set(result.completions.map((c) => cellKey(c.habitId, c.date))),
        );
        setLoadError("");
      })
      .catch((error) => {
        if (live) setLoadError(habitError(error));
      });
    return () => {
      live = false;
    };
  }, [desktop, month, reload]);

  // Today comes from Rust; read it again after local midnight.
  const today = data?.today ?? localDate(new Date());
  useEffect(() => {
    const timer = window.setTimeout(
      () => setReload((count) => count + 1),
      msUntilNextLocalMidnight(new Date()),
    );
    return () => window.clearTimeout(timer);
  }, [today]);

  const go = useCallback((next: string) => {
    if (next >= FIRST_MONTH && next <= LAST_MONTH) setMonth(next);
  }, []);
  const goToday = useCallback(() => go(monthOf(today)), [go, today]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!shortcutAllowed(event)) return;
      const action =
        event.code === "KeyT"
          ? goToday
          : event.code === "Comma"
            ? () => go(shiftMonth(month, -1))
            : event.code === "Period"
              ? () => go(shiftMonth(month, 1))
              : null;
      if (!action) return;
      event.preventDefault();
      action();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, goToday, month]);

  const save = useCallback(
    async (habit: Habit, date: string, want: boolean) => {
      const key = cellKey(habit.id, date);
      wanted.current.set(key, want);
      setPending(new Map(wanted.current));
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setFailure(null);
      setStatus("Saving…");
      try {
        let saved: boolean;
        do {
          const sending = wanted.current.get(key)!;
          saved = await setHabitCompletion(habit.id, date, sending);
          setDone((current) => {
            const next = new Set(current);
            if (saved) next.add(key);
            else next.delete(key);
            return next;
          });
        } while (wanted.current.get(key) !== saved);
        wanted.current.delete(key);
        setStatus(
          `Saved: ${habit.name}, ${fullDate(date)}, ${saved ? "done" : "not done"}.`,
        );
      } catch (error) {
        const want = wanted.current.get(key)!;
        wanted.current.delete(key);
        setStatus("");
        setFailure({ habit, date, done: want, message: habitError(error) });
      } finally {
        inFlight.current.delete(key);
        setPending(new Map(wanted.current));
      }
    },
    [],
  );

  const isDone = (key: string) => pending.get(key) ?? done.has(key);

  function retry() {
    if (!failure) return;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-failed]`)?.focus();
    void save(failure.habit, failure.date, failure.done);
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name"));
    try {
      await createHabit(name);
      form.reset();
      setAddError("");
      setReload((count) => count + 1);
    } catch (error) {
      setAddError(habitError(error));
    }
  }

  const [year, index] = month.split("-").map(Number);
  const title = monthTitle(month);
  const showsToday = month === monthOf(today);

  return (
    <section className="habits-view">
      <h1>Habits</h1>
      <p>Check off each day you practice. Earlier months keep their history.</p>
      {!desktop && <p>Open the desktop app to track your local habits.</p>}
      {desktop && (
        <>
          <nav className="habit-month-nav" aria-label="Month">
            <button
              type="button"

              onClick={() => go(shiftMonth(month, -1))}
              disabled={month <= FIRST_MONTH}
              aria-label={`Previous month, ${monthTitle(shiftMonth(month, -1))}`}
              aria-keyshortcuts="Alt+Shift+Comma"
              title="Previous month (Alt/Option+Shift+,)"
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <h2 aria-live="polite">{title}</h2>
            <button
              type="button"

              onClick={() => go(shiftMonth(month, 1))}
              disabled={month >= LAST_MONTH}
              aria-label={`Next month, ${monthTitle(shiftMonth(month, 1))}`}
              aria-keyshortcuts="Alt+Shift+Period"
              title="Next month (Alt/Option+Shift+.)"
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
            <label>
              <span className="visually-hidden">Month</span>
              <select
                value={index}
                onChange={(event) =>
                  go(
                    `${String(year).padStart(4, "0")}-${event.target.value.padStart(2, "0")}`,
                  )
                }
              >
                {monthNames.map((name, i) => (
                  <option key={name} value={i + 1}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="visually-hidden">Year</span>
              <input
                key={year}
                type="number"
                min={1900}
                max={9999}
                defaultValue={year}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next >= 1900 && next <= 9999)
                    go(`${next}-${String(index).padStart(2, "0")}`);
                }}
              />
            </label>
            <button
              type="button"
              className="habit-today-button"
              onClick={goToday}
              aria-pressed={showsToday}
              aria-keyshortcuts="Alt+Shift+T"
              title="Today (Alt/Option+Shift+T)"
            >
              Today
            </button>
          </nav>
          <form aria-label="Add a habit" className="habit-add" onSubmit={add}>
            <label>
              New habit
              <input name="name" required maxLength={60} />
            </label>
            <button className="action" type="submit">
              Add habit
            </button>
          </form>
          {addError && <p role="alert">{addError}</p>}
        </>
      )}
      <p role="status" className="habit-status">
        {status}
      </p>
      {failure && (
        <div role="alert" className="habit-failure">
          <p>
            Could not save {failure.habit.name}, {fullDate(failure.date)}.{" "}
            {failure.message}
          </p>
          <button type="button" className="action" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {loadError && (
        <div role="alert">
          <p>{loadError}</p>
          <button
            type="button"
            className="action"
            onClick={() => {
              setLoadError("");
              setReload((count) => count + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {desktop && !loadError && data === null && <p>Loading habits…</p>}
      {data && total === 0 && (
        <div className="issues-empty">
          <CircleCheck size={24} aria-hidden="true" />
          <h2>No habits yet</h2>
          <p>Add a habit to start checking off days.</p>
        </div>
      )}
      {data && total !== 0 && data.habits.length === 0 && (
        <p>No habit was active in {title}. Your history is in other months.</p>
      )}
      {data && data.habits.length > 0 && (
        <div ref={gridRef}>
          <HabitGrid
            key={month}
            caption={`Habits, ${title}`}
            dates={monthDates(month)}
            habits={data.habits}
            today={data.today}
            isDone={isDone}
            isSaving={(key) => pending.has(key)}
            failedKey={failure ? cellKey(failure.habit.id, failure.date) : null}
            onToggle={(habit, date) =>
              void save(habit, date, !isDone(cellKey(habit.id, date)))
            }
          />
        </div>
      )}
    </section>
  );
}
