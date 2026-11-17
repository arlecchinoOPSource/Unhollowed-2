import { expect, test } from "vitest";
import type { Habit } from "../../src/database/habits";
import {
  cellState,
  gridMoveForKey,
  monthDates,
  moveCell,
} from "../../src/features/habits/gridRules";

const habit = (startDate: string, archivedOn: string | null = null): Habit => ({
  id: "h",
  name: "Walk",
  position: 0,
  startDate,
  archivedOn,
  source: null,
  sourceId: null,
  revision: 0,
  createdAt: "",
  updatedAt: "",
});

test("February has 28 or 29 rows by the Gregorian leap rule (F4)", () => {
  expect(monthDates("2027-02")).toHaveLength(28);
  expect(monthDates("2028-02")).toHaveLength(29);
  expect(monthDates("2100-02")).toHaveLength(28);
  expect(monthDates("2000-02")).toHaveLength(29);
  expect(monthDates("2028-02").at(-1)).toBe("2028-02-29");
  expect(monthDates("2026-11")[0]).toBe("2026-11-01");
});

test("cell states follow the docs fixture F3", () => {
  const today = "2026-11-17";
  const active = habit("2026-11-05");
  const archived = habit("2026-11-05", "2026-11-12");
  const table: [string, string, string][] = [
    ["2026-11-04", "inactive", "inactive"],
    ["2026-11-05", "open", "open"],
    ["2026-11-12", "open", "open"],
    ["2026-11-13", "open", "inactive"],
    ["2026-11-17", "open", "inactive"],
    ["2026-11-18", "future", "future"],
  ];
  for (const [date, forActive, forArchived] of table) {
    expect(cellState(active, date, today), date).toBe(forActive);
    expect(cellState(archived, date, today), date).toBe(forArchived);
  }
});

test("keyboard moves stay inside the grid", () => {
  const rows = 30;
  const cols = 3;
  expect(moveCell(0, 0, "left", rows, cols)).toEqual([0, 0]);
  expect(moveCell(0, 0, "up", rows, cols)).toEqual([0, 0]);
  expect(moveCell(0, 2, "right", rows, cols)).toEqual([0, 2]);
  expect(moveCell(5, 1, "row-start", rows, cols)).toEqual([5, 0]);
  expect(moveCell(5, 1, "row-end", rows, cols)).toEqual([5, 2]);
  expect(moveCell(5, 1, "first", rows, cols)).toEqual([0, 0]);
  expect(moveCell(5, 1, "last", rows, cols)).toEqual([29, 2]);
  expect(moveCell(3, 1, "page-up", rows, cols)).toEqual([0, 1]);
  expect(moveCell(25, 1, "page-down", rows, cols)).toEqual([29, 1]);
  expect(moveCell(10, 1, "page-down", rows, cols)).toEqual([17, 1]);
  expect(gridMoveForKey("Home", true)).toBe("first");
  expect(gridMoveForKey("End", false)).toBe("row-end");
  expect(gridMoveForKey(" ", false)).toBeNull();
});
