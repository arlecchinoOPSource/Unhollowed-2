import { widgetDefinition } from "./widgets";

/**
 * Placement rules for the dashboard grid, shared by display and editing so
 * what you arrange is exactly what is shown. The grid has 12 columns and
 * unbounded rows. Rules, in order:
 *
 * 1. A widget keeps its size and column, clamped to the grid.
 * 2. The widget being edited keeps the spot it was given.
 * 3. Every other widget, in reading order (row, then column), moves up as far
 *    as it can without overlapping a widget already placed and without
 *    passing above a widget over it in the same columns, and down past
 *    anything it would overlap.
 *
 * The result has no overlaps, depends only on the input, and puts equal input
 * in equal order, so the same layout draws the same way every time.
 */
export const COLUMNS = 12;
export const MAX_ROWS = 40;
/** Below this width the grid is one column in reading order. */
export const NARROW = 900;

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function fit<T extends Box>(item: T): T {
  const w = clamp(Math.round(item.w), 1, COLUMNS);
  return {
    ...item,
    w,
    x: clamp(Math.round(item.x), 0, COLUMNS - w),
    y: Math.max(0, Math.round(item.y)),
    h: clamp(Math.round(item.h), 1, MAX_ROWS),
  };
}

/** Reading order: row first, then column, then ID so ties never flip. */
const reading = (a: Box, b: Box) =>
  a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const sharesColumns = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w;

/** Places boxes without overlap. `pinned` keeps its requested position. */
export function settle<T extends Box>(
  items: readonly T[],
  pinned?: string,
): T[] {
  const fitted = items.map(fit);
  const first = fitted.find((item) => item.id === pinned);
  const rest = fitted.filter((item) => item.id !== pinned).sort(reading);
  const placed: T[] = first ? [first] : [];
  const done: T[] = [];
  for (const item of rest) {
    // A widget never moves above one that sits above it in the same columns,
    // so closing a gap cannot make it jump over its neighbors.
    let floor = 0;
    for (const above of done)
      if (sharesColumns(item, above)) floor = Math.max(floor, above.y);
    if (first && sharesColumns(item, first) && reading(first, item) < 0)
      floor = Math.max(floor, first.y);
    const rows = [floor, ...placed.map((other) => other.y + other.h)]
      .filter((row) => row >= floor)
      .sort((a, b) => a - b);
    const y = rows.find((row) =>
      placed.every((other) => !overlaps({ ...item, y: row }, other)),
    )!;
    const next = { ...item, y };
    placed.push(next);
    done.push(next);
  }
  const byId = new Map(placed.map((item) => [item.id, item]));
  return items.map((item) => byId.get(item.id)!);
}

/** Moves one widget by whole columns and rows; the others make room. */
export function move<T extends Box>(
  items: readonly T[],
  id: string,
  dx: number,
  dy: number,
): T[] {
  return settle(
    items.map((item) =>
      item.id === id ? { ...item, x: item.x + dx, y: item.y + dy } : item,
    ),
    id,
  );
}

/** Resizes one widget within its type's limits; the others make room. */
export function resize<T extends Box & { type: string }>(
  items: readonly T[],
  id: string,
  dw: number,
  dh: number,
): T[] {
  return settle(
    items.map((item) => {
      if (item.id !== id) return item;
      const size = widgetDefinition(item.type)?.size;
      const minW = size?.minW ?? 1;
      const minH = size?.minH ?? 1;
      const w = clamp(item.w + dw, minW, COLUMNS);
      return {
        ...item,
        w,
        x: Math.min(item.x, COLUMNS - w),
        h: clamp(item.h + dh, minH, MAX_ROWS),
      };
    }),
    id,
  );
}

/** What a screen reader hears after a change. */
export const describe = (item: Box) =>
  `column ${item.x + 1}, row ${item.y + 1}, ${item.w} ${
    item.w === 1 ? "column" : "columns"
  } wide, ${item.h} ${item.h === 1 ? "row" : "rows"} tall`;
