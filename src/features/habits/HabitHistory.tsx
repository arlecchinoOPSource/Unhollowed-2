import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Link } from "react-router";
import {
  getHabitMonth,
  habitError,
  listHabitHistory,
  listHabits,
  type Habit,
} from "../../database/habits";
import {
  daysInMonth,
  fullDate,
  monthTitle,
  shiftMonth,
} from "../calendar/monthGrid";
import { localDate } from "../today/dates";
import { cellState, FIRST_MONTH, LAST_MONTH, monthDates } from "./gridRules";

type View = "month" | "year";
type DayState = "completed" | "missed" | "open" | "before" | "after" | "future";

const glyph: Record<DayState, string> = {
  completed: "✓",
  missed: "×",
  open: "○",
  before: "–",
  after: "–",
  future: "",
};
const words: Record<DayState, string> = {
  completed: "Completed",
  missed: "Missed",
  open: "Not done yet today",
  before: "Not active: before the habit started",
  after: "Not active: after the habit was archived",
  future: "Future day",
};

/** The documented rules: eligible from the start through the archive day, never future. */
export function dayState(
  habit: Habit,
  date: string,
  today: string,
  done: ReadonlySet<string>,
): DayState {
  const state = cellState(habit, date, today);
  if (state === "future") return "future";
  if (state === "inactive") return date < habit.startDate ? "before" : "after";
  if (done.has(date)) return "completed";
  return date === today ? "open" : "missed";
}

function yearDates(year: number): string[] {
  const pad = String(year).padStart(4, "0");
  return Array.from({ length: 12 }, (_, i) =>
    monthDates(`${pad}-${String(i + 1).padStart(2, "0")}`),
  ).flat();
}

/** Monday = 0. */
const weekday = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
};

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

/**
 * One habit's history as a month calendar or a year heatmap. Eligibility and
 * completions come from the same commands as the checkbox grid. State is
 * shown by a symbol and a word as well as by fill. One Tab stop; arrow keys
 * move by day or week, Page Up and Down change the month or year, and Enter
 * or Space selects a day to read its detail and open it in the grid.
 */
export function HabitHistory({ reload }: { reload: number }) {
  const [habits, setHabits] = useState<Habit[] | null>(null);
  const [today, setToday] = useState(localDate(new Date()));
  const [habitId, setHabitId] = useState("");
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<View>("month");
  const [focus, setFocus] = useState(localDate(new Date()));
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const moved = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const now = new Date();
    Promise.all([
      listHabits(),
      getHabitMonth(now.getFullYear(), now.getMonth() + 1),
    ])
      .then(([list, month]) => {
        if (!live) return;
        setHabits(list);
        setToday(month.today);
        setHabitId((current) =>
          list.some((habit) => habit.id === current)
            ? current
            : (list[0]?.id ?? ""),
        );
        setError("");
      })
      .catch((cause) => live && setError(habitError(cause)));
    return () => {
      live = false;
    };
  }, [reload, retry]);

  useEffect(() => {
    if (!habitId) return;
    let live = true;
    listHabitHistory(habitId)
      .then((dates) => live && setDone(new Set(dates)))
      .catch((cause) => live && setError(habitError(cause)));
    return () => {
      live = false;
    };
  }, [habitId, reload, retry]);

  const habit = habits?.find(({ id }) => id === habitId);
  const month = focus.slice(0, 7);
  const year = Number(focus.slice(0, 4));
  const dates = useMemo(
    () => (view === "month" ? monthDates(month) : yearDates(year)),
    [view, month, year],
  );
  const lead = weekday(dates[0] ?? focus);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    root.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${focus}"]`)
      ?.focus();
  });

  function jump(date: string) {
    if (date.slice(0, 7) < FIRST_MONTH || date.slice(0, 7) > LAST_MONTH) return;
    moved.current = true;
    setFocus(date);
  }

  function shiftPeriod(step: number) {
    const [y, m, d] = focus.split("-").map(Number);
    const target =
      view === "month"
        ? shiftMonth(month, step)
        : `${String(y + step).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    if (target < FIRST_MONTH || target > LAST_MONTH) return;
    const last = daysInMonth(target);
    setFocus(`${target}-${String(Math.min(d, last)).padStart(2, "0")}`);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const week = view === "month" ? 7 : 1;
    const day = view === "month" ? 1 : 7;
    const next: Record<string, string> = {
      ArrowLeft: addDays(focus, -day),
      ArrowRight: addDays(focus, day),
      ArrowUp: addDays(focus, -week),
      ArrowDown: addDays(focus, week),
    };
    if (event.key in next) {
      event.preventDefault();
      jump(next[event.key]);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      moved.current = true;
      shiftPeriod(event.key === "PageUp" ? -1 : 1);
    }
  }

  const title = view === "month" ? monthTitle(month) : String(year);
  const completedHere = habit
    ? dates.filter((date) => dayState(habit, date, today, done) === "completed")
        .length
    : 0;
  const eligibleHere = habit
    ? dates.filter((date) => {
        const s = dayState(habit, date, today, done);
        return s !== "before" && s !== "after" && s !== "future";
      }).length
    : 0;

  return (
    <section className="habit-history" aria-labelledby="habit-history-title">
      <h2 id="habit-history-title">Habit history</h2>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="action"
            onClick={() => setRetry((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {habits === null && !error && <p>Loading history…</p>}
      {habits?.length === 0 && (
        <p>No habits yet. Add a habit to see its history.</p>
      )}
      {habit && (
        <>
          <div className="habit-range">
            <label>
              Habit
              <select
                value={habitId}
                onChange={(event) => {
                  setHabitId(event.target.value);
                  setSelected(null);
                }}
              >
                {habits!.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.archivedOn ? " (archived)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div role="group" aria-label="View">
              {(["month", "year"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="action"
                  aria-pressed={view === option}
                  onClick={() => setView(option)}
                >
                  {option === "month" ? "Month" : "Year"}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="action"
              onClick={() => shiftPeriod(-1)}
              aria-label={view === "month" ? "Previous month" : "Previous year"}
            >
              ‹
            </button>
            <h3 aria-live="polite">{title}</h3>
            <button
              type="button"
              className="action"
              onClick={() => shiftPeriod(1)}
              aria-label={view === "month" ? "Next month" : "Next year"}
            >
              ›
            </button>
          </div>
          <p>
            {completedHere} of {eligibleHere} eligible days completed in {title}
            .
          </p>
          <div
            ref={root}
            role="group"
            aria-label={`${habit.name}, ${title}. Use arrow keys to move between days, Page Up and Page Down to change the ${view}.`}
            className={`habit-days habit-days-${view}`}
            onKeyDown={onKeyDown}
          >
            {Array.from({ length: lead }, (_, index) => (
              <span key={`lead-${index}`} aria-hidden="true" />
            ))}
            {dates.map((date) => {
              const state = dayState(habit, date, today, done);
              return (
                <button
                  key={date}
                  type="button"
                  data-date={date}
                  data-state={state}
                  data-selected={selected === date || undefined}
                  tabIndex={date === focus ? 0 : -1}
                  aria-label={`${fullDate(date)}: ${words[state]}`}
                  aria-current={date === today ? "date" : undefined}
                  onFocus={() => setFocus(date)}
                  onClick={() => setSelected(date)}
                >
                  {view === "month" && (
                    <span className="habit-day-number">
                      {Number(date.slice(8))}
                    </span>
                  )}
                  <span aria-hidden="true">{glyph[state]}</span>
                </button>
              );
            })}
          </div>
          <p className="habit-legend">
            ✓ completed, × missed, ○ today, not done yet, – not active, empty
            dashed: future. Dates are local days.
          </p>
          <div role="status" className="habit-day-detail">
            {selected ? (
              <>
                <strong>{fullDate(selected)}</strong>:{" "}
                {words[dayState(habit, selected, today, done)]}.{" "}
                <Link
                  to={`/habits?habit=${encodeURIComponent(habit.id)}&date=${selected}`}
                >
                  Open {fullDate(selected)} in the checkbox grid
                </Link>
              </>
            ) : (
              "Select a day for its detail."
            )}
          </div>
        </>
      )}
    </section>
  );
}
