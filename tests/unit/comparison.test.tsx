import { expect, test } from "vitest";
import {
  align,
  bucketsOf,
  fromEngine,
} from "../../src/features/dashboard/comparison";
import { widgetDefinition } from "../../src/features/dashboard/widgets";

test("weeks run Monday to Sunday and are clipped to the period", () => {
  // 2026-11-04 is a Wednesday.
  expect(bucketsOf({ from: "2026-11-04", to: "2026-11-18" }, "week")).toEqual([
    { start: "2026-11-04", end: "2026-11-08" },
    { start: "2026-11-09", end: "2026-11-15" },
    { start: "2026-11-16", end: "2026-11-18" },
  ]);
  // A period inside one week is one bucket.
  expect(bucketsOf({ from: "2026-11-09", to: "2026-11-10" }, "week")).toEqual([
    { start: "2026-11-09", end: "2026-11-10" },
  ]);
});

test("months are calendar months clipped to the period, leap day included", () => {
  expect(bucketsOf({ from: "2028-02-10", to: "2028-04-02" }, "month")).toEqual([
    { start: "2028-02-10", end: "2028-02-29" },
    { start: "2028-03-01", end: "2028-03-31" },
    { start: "2028-04-01", end: "2028-04-02" },
  ]);
});

test("every day of the period is in exactly one bucket", () => {
  const period = { from: "2026-01-01", to: "2026-12-31" };
  for (const grain of ["week", "month"] as const) {
    const buckets = bucketsOf(period, grain);
    expect(buckets[0].start).toBe(period.from);
    expect(buckets[buckets.length - 1].end).toBe(period.to);
    buckets.slice(1).forEach((b, i) => {
      const previous = new Date(`${buckets[i].end}T00:00:00Z`);
      previous.setUTCDate(previous.getUTCDate() + 1);
      expect(b.start).toBe(previous.toISOString().slice(0, 10));
    });
  }
});

test("daily items are summed into weeks and reconcile with the source total", () => {
  const buckets = bucketsOf({ from: "2026-11-02", to: "2026-11-15" }, "week");
  const days = [
    ["2026-11-02", 1],
    ["2026-11-04", 2],
    ["2026-11-09", 0],
    ["2026-11-15", 4],
  ].map(([d, value]) => ({
    start: d as string,
    end: d as string,
    value: value as number,
  }));
  const aligned = align(buckets, days, "2026-12-01", "Issues");
  expect(aligned.values).toEqual([3, 4]);
  expect(aligned.total).toBe(7);
  expect(aligned.covered).toBe(2);
  expect(aligned.problem).toBeNull();
});

test("a week with no items has no data, which is not zero", () => {
  const buckets = bucketsOf({ from: "2026-11-02", to: "2026-11-22" }, "week");
  const aligned = align(
    buckets,
    [{ start: "2026-11-02", end: "2026-11-02", value: 0 }],
    "2026-12-01",
    "x",
  );
  expect(aligned.values).toEqual([0, null, null]);
  expect(aligned.covered).toBe(1);
});

test("weeks after today have no data yet", () => {
  const buckets = bucketsOf({ from: "2026-11-02", to: "2026-11-22" }, "week");
  const items = buckets.map((b) => ({ start: b.start, end: b.end, value: 5 }));
  const aligned = align(buckets, items, "2026-11-10", "x");
  expect(aligned.values).toEqual([5, 5, null]);
});

test("source weeks align by week and refuse to be split into months", () => {
  const period = { from: "2026-01-05", to: "2026-06-28" };
  const weeks = bucketsOf(period, "week");
  const items = weeks.map((b) => ({ start: b.start, end: b.end, value: 1 }));
  const byWeek = align(weeks, items, "2027-01-01", "Issue completions");
  expect(byWeek.problem).toBeNull();
  expect(byWeek.total).toBe(weeks.length);
  const byMonth = align(
    bucketsOf(period, "month"),
    items,
    "2027-01-01",
    "Issue completions",
  );
  expect(byMonth.problem).toMatch(/cannot be shown by month/);
  expect(byMonth.covered).toBe(0);
});

test("engine buckets are placed by their own boundaries, never guessed", () => {
  const buckets = bucketsOf({ from: "2026-11-02", to: "2026-11-15" }, "week");
  const aligned = fromEngine(buckets, [
    { start: "2026-11-02", end: "2026-11-08", value: 50 },
    { start: "2026-11-09", end: "2026-11-15", value: null },
  ]);
  expect(aligned.values).toEqual([50, null]);
  expect(aligned.covered).toBe(1);
  // A bucket the engine cut differently does not match.
  expect(
    fromEngine(buckets, [{ start: "2026-11-03", end: "2026-11-08", value: 1 }])
      .values,
  ).toEqual([null, null]);
});

test("the comparison widget validates its grouping and period", () => {
  const parse = widgetDefinition("comparison")!.parse;
  expect(parse(undefined)).toEqual({ grain: "week" });
  expect(parse({ grain: "month" })).toEqual({ grain: "month" });
  expect(parse({ grain: "year" })).toBeNull();
  expect(parse({ grain: "week", period: { preset: "last7" } })).toEqual({
    grain: "week",
    period: { preset: "last7" },
  });
  expect(parse({ score: 1 })).toBeNull();
});
