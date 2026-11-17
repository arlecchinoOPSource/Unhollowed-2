// Ported from Ember desktop/src/calendar.ts (revision 2351a23), MIT License,
// Copyright (c) 2026 Arlecchino. Changes are listed in docs/HABITS.md.
import type { Habit } from "../../database/habits";
import { daysInMonth } from "../calendar/monthGrid";

/** Habit grid rules. Pure functions; dates are local YYYY-MM-DD compared as text. */

/** Months the grid can show, so dates keep four-digit years. */
export const FIRST_MONTH = "1900-01";
export const LAST_MONTH = "9999-12";

/** Every date of a YYYY-MM month, in order. */
export function monthDates(month: string): string[] {
  return Array.from(
    { length: daysInMonth(month) },
    (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
  );
}

export type CellState = "open" | "future" | "inactive";

/**
 * Whether a habit-day can be changed. Eligible from the start date through
 * the archive day, inclusive, and never after today. Unlike Ember, days
 * before the start are inactive even while the habit is active.
 */
export function cellState(
  habit: Habit,
  date: string,
  today: string,
): CellState {
  if (date > today) return "future";
  if (date < habit.startDate) return "inactive";
  if (habit.archivedOn !== null && date > habit.archivedOn) return "inactive";
  return "open";
}

export type GridMove =
  | "left"
  | "right"
  | "up"
  | "down"
  | "row-start"
  | "row-end"
  | "first"
  | "last"
  | "page-up"
  | "page-down";

/** ARIA grid movement. Rows are dates, columns habits. Stays inside the grid. */
export function moveCell(
  row: number,
  col: number,
  move: GridMove,
  rows: number,
  cols: number,
): [number, number] {
  const clampRow = (r: number) => Math.min(rows - 1, Math.max(0, r));
  const clampCol = (c: number) => Math.min(cols - 1, Math.max(0, c));
  switch (move) {
    case "left":
      return [row, clampCol(col - 1)];
    case "right":
      return [row, clampCol(col + 1)];
    case "up":
      return [clampRow(row - 1), col];
    case "down":
      return [clampRow(row + 1), col];
    case "row-start":
      return [row, 0];
    case "row-end":
      return [row, cols - 1];
    case "first":
      return [0, 0];
    case "last":
      return [rows - 1, cols - 1];
    case "page-up":
      return [clampRow(row - 7), col];
    case "page-down":
      return [clampRow(row + 7), col];
  }
}

/** The grid move for a key, or null for keys the grid leaves alone. */
export function gridMoveForKey(
  key: string,
  ctrlOrMeta: boolean,
): GridMove | null {
  switch (key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "Home":
      return ctrlOrMeta ? "first" : "row-start";
    case "End":
      return ctrlOrMeta ? "last" : "row-end";
    case "PageUp":
      return "page-up";
    case "PageDown":
      return "page-down";
    default:
      return null;
  }
}
