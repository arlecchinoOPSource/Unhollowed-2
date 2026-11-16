import { afterEach, describe, expect, test } from "vitest";
import {
  addDays,
  dayLabel,
  localDate,
  msUntilNextLocalMidnight,
} from "../../src/features/today/dates";

const HOUR = 60 * 60 * 1000;
const originalZone = process.env.TZ;

// Node applies a changed TZ to later Date calls.
function inZone(zone: string) {
  process.env.TZ = zone;
}

afterEach(() => {
  process.env.TZ = originalZone;
});

describe("local calendar dates", () => {
  test("change at local midnight, not at UTC midnight", () => {
    inZone("Asia/Manila"); // UTC+8
    expect(localDate(new Date("2026-11-16T15:59:59Z"))).toBe("2026-11-16");
    expect(localDate(new Date("2026-11-16T16:00:00Z"))).toBe("2026-11-17");
    inZone("America/Los_Angeles"); // UTC-8 in November
    expect(localDate(new Date("2026-11-17T07:59:59Z"))).toBe("2026-11-16");
    expect(localDate(new Date("2026-11-17T08:00:00Z"))).toBe("2026-11-17");
  });

  test("follow a time zone change for the same instant", () => {
    const instant = new Date("2026-11-16T20:00:00Z");
    inZone("America/New_York");
    expect(localDate(instant)).toBe("2026-11-16");
    inZone("Pacific/Auckland");
    expect(localDate(instant)).toBe("2026-11-17");
  });

  test("count days across month, year, and leap-day boundaries", () => {
    inZone("America/New_York");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  test("step over daylight-saving days without skipping or repeating", () => {
    inZone("America/New_York");
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });
});

describe("time until the next local midnight", () => {
  test("is a full day from midnight on an ordinary day", () => {
    inZone("America/New_York");
    expect(msUntilNextLocalMidnight(new Date(2026, 10, 16))).toBe(24 * HOUR);
    expect(msUntilNextLocalMidnight(new Date(2026, 10, 16, 23, 59, 30))).toBe(
      30 * 1000,
    );
  });

  test("is 23 hours on the spring-forward day and 25 on the fall-back day", () => {
    inZone("America/New_York");
    expect(msUntilNextLocalMidnight(new Date(2026, 2, 8))).toBe(23 * HOUR);
    expect(msUntilNextLocalMidnight(new Date(2026, 10, 1))).toBe(25 * HOUR);
    inZone("Europe/Paris");
    expect(msUntilNextLocalMidnight(new Date(2026, 2, 29))).toBe(23 * HOUR);
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 25))).toBe(25 * HOUR);
  });

  test("lands on the next local date", () => {
    inZone("America/New_York");
    for (const start of [
      new Date(2026, 2, 8, 1, 30),
      new Date(2026, 10, 1, 1, 30),
    ]) {
      const after = new Date(start.getTime() + msUntilNextLocalMidnight(start));
      expect(localDate(after)).toBe(localDate(start, 1));
      expect(after.getHours()).toBe(0);
    }
  });
});

describe("day labels", () => {
  test("name today, tomorrow, this week, and later dates", () => {
    inZone("America/New_York");
    expect(dayLabel("2026-11-16", "2026-11-16")).toBe("Today");
    expect(dayLabel("2026-11-17", "2026-11-16")).toBe("Tomorrow");
    const weekday = dayLabel("2026-11-20", "2026-11-16");
    expect(weekday).toBe(
      new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(
        new Date(2026, 10, 20),
      ),
    );
    expect(dayLabel("2026-12-25", "2026-11-16")).not.toMatch(/2026/);
    // Past dates name the day of the month, not just a weekday.
    expect(dayLabel("2026-11-10", "2026-11-16")).toMatch(/10/);
    expect(dayLabel("2027-01-05", "2026-11-16")).toMatch(/2027/);
  });
});
