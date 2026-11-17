// Interaction contract ported from Ember desktop/src/HabitGrid.tsx (revision
// 2351a23), MIT License, Copyright (c) 2026 Arlecchino.
import { Check } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type { Habit } from "../../database/habits";
import { fullDate } from "../calendar/monthGrid";
import { parseLocalDate } from "../today/dates";
import { cellState, gridMoveForKey, moveCell } from "./gridRules";

export const cellKey = (habitId: string, date: string) => `${habitId}|${date}`;

const reasons = {
  open: "",
  future: "future day",
  inactive: "not active on this day",
} as const;

interface Props {
  caption: string;
  dates: string[];
  habits: Habit[];
  today: string;
  isDone: (key: string) => boolean;
  isSaving: (key: string) => boolean;
  failedKey: string | null;
  /** A cell to land on, from a history link. Ignored if it is not in view. */
  target?: { habitId: string; date: string } | null;
  onToggle: (habit: Habit, date: string) => void;
}

/**
 * The month grid: one row per date, one column per habit in saved order
 * (ARIA grid pattern). One Tab stop; arrows, Home/End, Ctrl/⌘+Home/End, and
 * Page Up/Down move between cells; Space or Enter toggles. Unavailable cells
 * stay focusable with `aria-disabled` and say why, so moving never skips a
 * day. Buttons are never disabled or replaced while saving, so focus stays.
 */
export function HabitGrid({
  caption,
  dates,
  habits,
  today,
  isDone,
  isSaving,
  failedKey,
  target,
  onToggle,
}: Props) {
  const tableRef = useRef<HTMLTableElement>(null);
  // The parent keys the grid by month, so each month starts at today's row
  // when it is in view, otherwise day 1.
  const todayRow = dates.indexOf(today);
  const targetRow = target ? dates.indexOf(target.date) : -1;
  const targetCol = target
    ? habits.findIndex((habit) => habit.id === target.habitId)
    : -1;
  const landing = targetRow >= 0 && targetCol >= 0;
  const [focus, setFocus] = useState<[number, number]>(
    landing ? [targetRow, targetCol] : [Math.max(0, todayRow), 0],
  );
  const row = Math.min(focus[0], dates.length - 1);
  const col = Math.min(focus[1], Math.max(0, habits.length - 1));
  const moved = useRef(landing);

  // Bring today's row into view inside the grid, without scrolling the page.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const region = scrollRef.current;
    const current = region?.querySelector<HTMLElement>(
      landing
        ? `[data-cell="${targetRow}:${targetCol}"]`
        : "[aria-current='date']",
    );
    if (region && current)
      region.scrollTop = current.offsetTop - region.clientHeight / 2;
    // Runs once per mount; the parent remounts the grid for each month.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    tableRef.current
      ?.querySelector<HTMLButtonElement>(`[data-cell="${row}:${col}"]`)
      ?.focus();
  }, [row, col]);

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const move = gridMoveForKey(event.key, event.ctrlKey || event.metaKey);
    if (
      !move ||
      event.altKey ||
      !(event.target instanceof HTMLButtonElement) ||
      !event.target.dataset.cell
    )
      return;
    event.preventDefault();
    moved.current = true;
    setFocus(moveCell(row, col, move, dates.length, habits.length));
  }

  return (
    <div
      ref={scrollRef}
      className="habit-grid-scroll"
      role="region"
      tabIndex={-1}
      aria-label={`${caption}. Use arrow keys to move between days and habits.`}
    >
      <table
        ref={tableRef}
        role="grid"
        className="habit-grid"
        style={{ "--habit-columns": habits.length } as CSSProperties}
        aria-label={caption}
        aria-rowcount={dates.length + 1}
        aria-colcount={habits.length + 1}
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            <th scope="col" className="habit-day-heading">
              Day
            </th>
            {habits.map((habit) => (
              <th scope="col" key={habit.id}>
                <span className="habit-name">{habit.name}</span>
                {habit.archivedOn && (
                  <small className="habit-archived">Archived</small>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((date, r) => {
            const isToday = date === today;
            const long = fullDate(date);
            return (
              <tr
                key={date}
                className={isToday ? "habit-today" : undefined}
                aria-current={isToday ? "date" : undefined}
              >
                <th scope="row">
                  <b>{date.slice(8)}</b>
                  <small aria-hidden="true">
                    {parseLocalDate(date).toLocaleDateString(undefined, {
                      weekday: "short",
                    })}
                  </small>
                  {isToday && <em>Today</em>}
                  <span className="visually-hidden">{long}</span>
                </th>
                {habits.map((habit, c) => {
                  const state = cellState(habit, date, today);
                  const key = cellKey(habit.id, date);
                  const checked = isDone(key);
                  const saving = isSaving(key);
                  const unavailable = state !== "open";
                  return (
                    <td key={habit.id} role="gridcell">
                      <button
                        type="button"
                        className="habit-check"
                        data-cell={`${r}:${c}`}
                        data-state={state}
                        data-saving={saving || undefined}
                        data-failed={failedKey === key || undefined}
                        tabIndex={r === row && c === col ? 0 : -1}
                        aria-label={`${habit.name}, ${long}${unavailable ? `, ${reasons[state]}` : ""}${saving ? ", saving" : ""}`}
                        aria-pressed={checked}
                        aria-disabled={unavailable || undefined}
                        title={
                          unavailable
                            ? `${habit.name}: ${reasons[state]}`
                            : `${habit.name} · ${long}`
                        }
                        onFocus={() => {
                          if (r !== row || c !== col) setFocus([r, c]);
                        }}
                        onClick={() => {
                          if (!unavailable) onToggle(habit, date);
                        }}
                      >
                        {checked ? (
                          <Check size={16} aria-hidden="true" />
                        ) : unavailable ? (
                          <span aria-hidden="true">–</span>
                        ) : null}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
