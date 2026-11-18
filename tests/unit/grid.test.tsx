import { expect, test } from "vitest";
import {
  COLUMNS,
  describe as say,
  move,
  resize,
  settle,
  type Box,
} from "../../src/features/dashboard/grid";

type Item = Box & { type: string };
const item = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Item => ({
  id,
  type: "notes",
  x,
  y,
  w,
  h,
});

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function expectClean(list: Box[]) {
  for (const a of list) {
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(COLUMNS);
    expect(a.y).toBeGreaterThanOrEqual(0);
    for (const b of list) if (a !== b) expect(overlap(a, b)).toBe(false);
  }
}

test("overlapping widgets are pushed below, in reading order", () => {
  const out = settle([item("a", 0, 0, 12, 3), item("b", 0, 0, 12, 2)]);
  expect(out.find((i) => i.id === "a")!.y).toBe(0);
  expect(out.find((i) => i.id === "b")!.y).toBe(3);
});

test("gaps close upward and widgets share a row when they fit", () => {
  const out = settle([item("a", 0, 0, 6, 3), item("b", 6, 9, 6, 3)]);
  expect(out.map((i) => [i.x, i.y])).toEqual([
    [0, 0],
    [6, 0],
  ]);
});

test("the widget being moved keeps its spot and the others make room", () => {
  const start = [item("a", 0, 0, 12, 3), item("b", 0, 3, 12, 3)];
  const out = move(start, "b", 0, -3);
  expect(out.find((i) => i.id === "b")!.y).toBe(0);
  expect(out.find((i) => i.id === "a")!.y).toBe(3);
  expectClean(out);
});

test("moves clamp to the grid", () => {
  const out = move([item("a", 3, 0, 6, 2)], "a", 20, -5);
  expect(out[0]).toMatchObject({ x: 6, y: 0 });
  expect(move([item("a", 0, 0, 6, 2)], "a", -4, 0)[0].x).toBe(0);
});

test("resizing respects the type's limits and the grid edge", () => {
  const notes = [item("a", 8, 0, 4, 3)];
  expect(resize(notes, "a", 5, 0)[0]).toMatchObject({ w: 9, x: 3 });
  // Notes cannot be narrower than 3 columns or shorter than 2 rows.
  expect(resize(notes, "a", -9, -9)[0]).toMatchObject({ w: 3, h: 2 });
  expect(resize(notes, "a", 0, 99)[0].h).toBe(40);
});

test("equal input always gives equal output", () => {
  const input = [
    item("c", 0, 4, 6, 2),
    item("a", 6, 0, 6, 2),
    item("b", 0, 0, 6, 2),
  ];
  const once = settle(input);
  expect(settle(input)).toEqual(once);
  expect(settle(once)).toEqual(once);
  // Order of the list does not change where things land.
  expect(
    settle([...input].reverse()).sort((p, q) => (p.id < q.id ? -1 : 1)),
  ).toEqual([...once].sort((p, q) => (p.id < q.id ? -1 : 1)));
});

test("any sequence of moves and resizes leaves no overlap", () => {
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  let list: Item[] = settle(
    ["a", "b", "c", "d", "e"].map((id, i) => item(id, 0, i * 3, 12, 3)),
  );
  for (let step = 0; step < 300; step++) {
    const id = list[next(list.length)].id;
    list =
      next(2) === 0
        ? move(list, id, next(9) - 4, next(9) - 4)
        : resize(list, id, next(7) - 3, next(7) - 3);
    expectClean(list);
  }
});

test("out-of-range input is repaired, not trusted", () => {
  const out = settle([item("a", -5, -5, 99, 0)]);
  expect(out[0]).toMatchObject({ x: 0, y: 0, w: 12, h: 1 });
});

test("changes are described in words", () => {
  expect(say(item("a", 0, 0, 12, 1))).toBe(
    "column 1, row 1, 12 columns wide, 1 row tall",
  );
});
