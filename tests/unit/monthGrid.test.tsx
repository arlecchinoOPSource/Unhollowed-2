import { afterEach, expect, test } from "vitest";
import {
  daysInMonth,
  gridDays,
  readMonth,
  shiftDateByMonths,
  shiftMonth,
} from "../../src/features/calendar/monthGrid";

const originalZone = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalZone;
});

test("grids start on the Monday on or before the first and cover six weeks", () => {
  const november = gridDays("2026-11"); // 1 November 2026 is a Sunday.
  expect(november).toHaveLength(42);
  expect(november[0]).toBe("2026-10-26");
  expect(november[6]).toBe("2026-11-01");
  expect(november[41]).toBe("2026-12-06");
  expect(gridDays("2027-02")[0]).toBe("2027-02-01"); // A Monday.
});

test("grids are the same in every time zone, including daylight-saving months", () => {
  for (const zone of ["America/New_York", "Europe/Paris", "Pacific/Auckland"]) {
    process.env.TZ = zone;
    const days = gridDays("2026-11");
    expect(new Set(days).size).toBe(42);
    expect(days.slice(6, 9)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
    expect(gridDays("2026-03")[0]).toBe("2026-02-23");
  }
});

test("months shift across years and clamp to shorter months", () => {
  expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  expect(shiftMonth("2026-11", -23)).toBe("2024-12");
  expect(daysInMonth("2028-02")).toBe(29);
  expect(daysInMonth("2027-02")).toBe(28);
  expect(shiftDateByMonths("2026-01-31", 1)).toBe("2026-02-28");
  expect(shiftDateByMonths("2028-03-31", -1)).toBe("2028-02-29");
  expect(shiftDateByMonths("2026-11-16", 2)).toBe("2027-01-16");
});

test("only valid months are read from the URL", () => {
  expect(readMonth("2026-11", "x")).toBe("2026-11");
  for (const bad of ["2026-13", "2026-1", "nonsense", "", null, "0000-05"]) {
    expect(readMonth(bad, "fallback")).toBe("fallback");
  }
});
