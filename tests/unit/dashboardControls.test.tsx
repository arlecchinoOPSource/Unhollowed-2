import { beforeEach, expect, test } from "vitest";
import {
  daysIn,
  defaults,
  periodProblem,
  readPreferences,
  resolvePeriod,
  writePreferences,
  type Preferences,
} from "../../src/features/dashboard/controls";

const prefs = (over: Partial<Preferences> = {}): Preferences => ({
  ...defaults("2026-11-17"),
  ...over,
});

beforeEach(() => localStorage.clear());

test("last 7 and last 30 days are inclusive of today", () => {
  const seven = resolvePeriod(prefs({ preset: "last7" }), "2026-11-17");
  expect(seven).toEqual({ from: "2026-11-11", to: "2026-11-17" });
  expect(daysIn(seven)).toBe(7);
  const thirty = resolvePeriod(prefs({ preset: "last30" }), "2026-11-17");
  expect(thirty).toEqual({ from: "2026-10-19", to: "2026-11-17" });
  expect(daysIn(thirty)).toBe(30);
});

test("ranges cross month, year, and leap-day boundaries correctly", () => {
  expect(resolvePeriod(prefs({ preset: "last7" }), "2027-01-03")).toEqual({
    from: "2026-12-28",
    to: "2027-01-03",
  });
  expect(resolvePeriod(prefs({ preset: "last7" }), "2028-03-02")).toEqual({
    from: "2028-02-25",
    to: "2028-03-02",
  });
  // Across the 2026 spring-forward and fall-back weeks, days stay whole.
  expect(daysIn(resolvePeriod(prefs({ preset: "last30" }), "2026-04-05"))).toBe(
    30,
  );
  expect(daysIn(resolvePeriod(prefs({ preset: "last30" }), "2026-11-02"))).toBe(
    30,
  );
});

test("this month is the whole calendar month", () => {
  const month = (today: string) =>
    resolvePeriod(prefs({ preset: "month" }), today);
  expect(month("2026-11-17")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  expect(month("2026-12-31")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  expect(month("2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  expect(month("2027-02-10")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  expect(month("2026-01-01")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
});

test("custom dates are inclusive, validated, and fall back when unusable", () => {
  const custom = (from: string, to: string) =>
    prefs({ preset: "custom", custom: { from, to } });
  expect(
    resolvePeriod(custom("2026-11-05", "2026-11-05"), "2026-11-17"),
  ).toEqual({
    from: "2026-11-05",
    to: "2026-11-05",
  });
  expect(daysIn({ from: "2026-11-05", to: "2026-11-05" })).toBe(1);
  expect(daysIn({ from: "2028-02-28", to: "2028-03-01" })).toBe(3);
  // The longest allowed period is 366 days, inclusive.
  expect(periodProblem({ from: "2028-01-01", to: "2028-12-31" })).toBeNull();
  expect(periodProblem({ from: "2026-01-01", to: "2027-01-01" })).toBeNull();
  expect(periodProblem({ from: "2026-01-01", to: "2027-01-02" })).toMatch(
    /at most 366/,
  );
  expect(periodProblem({ from: "2026-11-06", to: "2026-11-05" })).toMatch(
    /on or before/,
  );
  for (const bad of ["", "2026-02-30", "2026-1-1", "tomorrow", "1899-12-31"])
    expect(periodProblem({ from: bad, to: "2026-11-05" })).toBe(
      "Enter both dates.",
    );
  // An unusable custom range shows the default period instead of failing.
  expect(
    resolvePeriod(custom("2026-11-06", "2026-11-05"), "2026-11-17"),
  ).toEqual({
    from: "2026-10-19",
    to: "2026-11-17",
  });
});

test("preferences are saved and read back", () => {
  const saved = prefs({
    preset: "custom",
    custom: { from: "2026-09-01", to: "2026-09-30" },
    hidden: ["mood", "schedule"],
  });
  writePreferences(saved);
  expect(readPreferences("2026-11-17")).toEqual(saved);
});

test("stored preferences that are missing, damaged, or unknown become the defaults", () => {
  const fallback = defaults("2026-11-17");
  expect(readPreferences("2026-11-17")).toEqual(fallback);
  for (const stored of [
    "not json",
    "null",
    "42",
    '"text"',
    JSON.stringify({ version: 2, preset: "last7" }),
  ]) {
    localStorage.setItem("unhollowed-2-dashboard", stored);
    expect(readPreferences("2026-11-17")).toEqual(fallback);
  }
  // Each field is repaired on its own.
  localStorage.setItem(
    "unhollowed-2-dashboard",
    JSON.stringify({
      version: 1,
      preset: "last3650",
      custom: { from: "2026-13-01", to: "2026-11-05" },
      hidden: ["mood", "mood", "nonsense", 7, "habits"],
    }),
  );
  expect(readPreferences("2026-11-17")).toEqual({
    preset: "last30",
    custom: fallback.custom,
    hidden: ["mood", "habits"],
  });
  localStorage.setItem(
    "unhollowed-2-dashboard",
    JSON.stringify({ version: 1, preset: "last7", hidden: "all" }),
  );
  expect(readPreferences("2026-11-17").hidden).toEqual([]);
  expect(readPreferences("2026-11-17").preset).toBe("last7");
});
