import { describe, expect, it } from "vitest";
import type { CalendarItem } from "../../src/database/events";
import { defaultSettings } from "../../src/features/calendar/settings";
import {
  layoutAllDay,
  layoutDay,
  stepDate,
  viewDays,
} from "../../src/features/calendar/timeline";

function item(
  id: string,
  fields: Partial<CalendarItem> & { title?: string },
): CalendarItem {
  return {
    kind: "event",
    id,
    eventId: id,
    occurrence: null,
    recurring: false,
    title: id,
    calendarId: "c",
    color: "blue",
    issueId: null,
    issueNumber: null,
    closed: false,
    allDay: false,
    startDate: null,
    endDate: null,
    start: null,
    end: null,
    startAt: null,
    endAt: null,
    timeZone: "UTC",
    localStart: null,
    localEnd: null,
    ...fields,
  };
}

const timed = (id: string, start: string, end: string) =>
  item(id, { start, end });

describe("timeline views", () => {
  it("chooses the days for Day, Week, and Workweek", () => {
    // 18 November 2026 is a Wednesday.
    expect(viewDays("day", "2026-11-18", defaultSettings)).toEqual([
      "2026-11-18",
    ]);
    expect(viewDays("week", "2026-11-18", defaultSettings)).toEqual([
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
      "2026-11-22",
    ]);
    expect(viewDays("workweek", "2026-11-22", defaultSettings)).toEqual([
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
    ]);
    // Configured days and a Sunday week start.
    const custom = { ...defaultSettings, weekStart: 0, workDays: [0, 2, 4] };
    expect(viewDays("workweek", "2026-11-18", custom)).toEqual([
      "2026-11-15",
      "2026-11-17",
      "2026-11-19",
    ]);
    expect(stepDate("week", "2026-12-28", 1)).toBe("2027-01-04");
    expect(stepDate("day", "2028-02-28", 1)).toBe("2028-02-29");
  });

  it("lays out overlaps side by side and clips items to the day", () => {
    const blocks = layoutDay(
      [
        timed("a", "2026-11-18T09:00", "2026-11-18T10:30"),
        timed("b", "2026-11-18T09:30", "2026-11-18T10:00"),
        timed("c", "2026-11-18T10:00", "2026-11-18T11:00"),
        // Touching end and start do not overlap.
        timed("d", "2026-11-18T11:00", "2026-11-18T12:00"),
        timed("night", "2026-11-17T22:00", "2026-11-18T01:00"),
        timed("other", "2026-11-19T09:00", "2026-11-19T10:00"),
      ],
      "2026-11-18",
    );
    const by = Object.fromEntries(
      blocks.map((block) => [
        block.item.id,
        [block.top, block.bottom, block.column, block.columns],
      ]),
    );
    expect(by).toEqual({
      night: [0, 60, 0, 1],
      a: [540, 630, 0, 2],
      b: [570, 600, 1, 2],
      // c starts when b ends, so it reuses b's column in the same cluster.
      c: [600, 660, 1, 2],
      d: [660, 720, 0, 1],
    });
    expect(blocks.find((block) => block.item.id === "night")).toMatchObject({
      continuesBefore: true,
      continuesAfter: false,
    });
    // Very short items get a readable minimum height.
    const [short] = layoutDay(
      [timed("s", "2026-11-18T08:00", "2026-11-18T08:05")],
      "2026-11-18",
    );
    expect(short.bottom - short.top).toBe(20);
  });

  it("bands all-day items across the shown days without overlap", () => {
    const days = viewDays("workweek", "2026-11-18", defaultSettings);
    const bands = layoutAllDay(
      [
        item("trip", {
          allDay: true,
          startDate: "2026-11-15",
          endDate: "2026-11-18",
        }),
        item("deadline", {
          kind: "deadline",
          allDay: true,
          startDate: "2026-11-17",
          endDate: "2026-11-18",
        }),
        item("weekend", {
          allDay: true,
          startDate: "2026-11-21",
          endDate: "2026-11-23",
        }),
      ],
      days,
    );
    expect(
      bands.map(({ item, first, last, row }) => [item.id, first, last, row]),
    ).toEqual([
      ["trip", 0, 1, 0],
      ["deadline", 1, 1, 1],
    ]);
  });
});
