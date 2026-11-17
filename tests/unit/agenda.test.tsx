import { describe, expect, it } from "vitest";
import type { CalendarItem } from "../../src/database/events";
import {
  busySpan,
  freeSpans,
  mergeSpans,
} from "../../src/features/calendar/intervals";
import { buildAgenda } from "../../src/features/today/agenda";

function item(over: Partial<CalendarItem>): CalendarItem {
  return {
    kind: "event",
    id: over.id ?? "x",
    eventId: null,
    occurrence: null,
    recurring: false,
    title: "T",
    calendarId: null,
    color: null,
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
    timeZone: null,
    localStart: null,
    localEnd: null,
    ...over,
  };
}

const timed = (id: string, start: string, end: string, kind = "event") =>
  item({ id, kind: kind as CalendarItem["kind"], start, end });

describe("intervals", () => {
  it("clips an item to the day", () => {
    expect(
      busySpan(
        timed("a", "2026-11-16T09:00", "2026-11-16T10:30"),
        "2026-11-16",
      ),
    ).toEqual([540, 630]);
    expect(
      busySpan(
        timed("b", "2026-11-15T22:00", "2026-11-16T01:00"),
        "2026-11-16",
      ),
    ).toEqual([0, 60]);
    expect(
      busySpan(
        timed("c", "2026-11-16T22:00", "2026-11-17T08:00"),
        "2026-11-16",
      ),
    ).toEqual([1320, 1440]);
    expect(
      busySpan(
        timed("d", "2026-11-17T09:00", "2026-11-17T10:00"),
        "2026-11-16",
      ),
    ).toBeNull();
    // Ending at midnight does not touch the next day.
    expect(
      busySpan(
        timed("e", "2026-11-15T23:00", "2026-11-16T00:00"),
        "2026-11-16",
      ),
    ).toBeNull();
  });

  it("merges overlapping and touching spans", () => {
    expect(
      mergeSpans([
        [600, 660],
        [540, 630],
        [660, 700],
        [800, 820],
      ]),
    ).toEqual([
      [540, 700],
      [800, 820],
    ]);
  });

  it("finds free time inside working hours", () => {
    expect(
      freeSpans(
        [
          [600, 660],
          [630, 700],
        ],
        540,
        1020,
      ),
    ).toEqual([
      [540, 600],
      [700, 1020],
    ]);
    // Busy time outside the window changes nothing, and a full day has none.
    expect(
      freeSpans(
        [
          [0, 500],
          [1100, 1200],
        ],
        540,
        1020,
      ),
    ).toEqual([[540, 1020]]);
    expect(freeSpans([[500, 1100]], 540, 1020)).toEqual([]);
    expect(freeSpans([], 600, 600)).toEqual([]);
  });
});

describe("agenda", () => {
  const today = "2026-11-16";
  it("separates all-day, timed, and coming-up items", () => {
    const agenda = buildAgenda(
      [
        item({
          id: "trip",
          allDay: true,
          startDate: "2026-11-15",
          endDate: "2026-11-17",
        }),
        item({
          id: "later",
          allDay: true,
          startDate: "2026-11-17",
          endDate: "2026-11-18",
        }),
        timed("late", "2026-11-16T14:00", "2026-11-16T15:00"),
        timed("early", "2026-11-16T09:00", "2026-11-16T10:00"),
        item({
          id: "due-today",
          kind: "deadline",
          issueId: "i1",
          issueNumber: 1,
          startDate: today,
          endDate: "2026-11-17",
          allDay: true,
        }),
        item({
          id: "due-2",
          kind: "deadline",
          issueId: "i2",
          issueNumber: 2,
          startDate: "2026-11-18",
          allDay: true,
        }),
        item({
          id: "due-1",
          kind: "deadline",
          issueId: "i3",
          issueNumber: 3,
          startDate: "2026-11-17",
          allDay: true,
        }),
        item({
          id: "done",
          kind: "deadline",
          issueId: "i4",
          issueNumber: 4,
          startDate: "2026-11-17",
          closed: true,
          allDay: true,
        }),
      ],
      today,
    );
    expect(agenda.allDay.map((i) => i.id)).toEqual(["trip"]);
    expect(agenda.timed.map((i) => i.id)).toEqual(["early", "late"]);
    // Today's deadlines belong to the task list. Closed ones are done.
    expect(agenda.comingUp.map((i) => i.id)).toEqual(["due-1", "due-2"]);
  });

  it("keeps work blocks of completed issues", () => {
    const block = {
      ...timed("wb", "2026-11-16T09:00", "2026-11-16T10:00", "workBlock"),
      closed: true,
    };
    expect(buildAgenda([block], today).timed.map((i) => i.id)).toEqual(["wb"]);
  });
});

import {
  availability,
  conflictsOf,
  overlaps,
  wallInstant,
  workWindow,
} from "../../src/features/calendar/intervals";

const NY = "America/New_York";
const HOUR = 3_600_000;
function at(
  id: string,
  startAt: string,
  endAt: string,
  over: Partial<CalendarItem> = {},
) {
  return item({ id, title: id, startAt, endAt, ...over });
}

describe("conflicts", () => {
  it("treats equal boundaries as adjacent, not overlapping", () => {
    expect(overlaps([0, 10], [10, 20])).toBe(false);
    expect(overlaps([0, 10], [9, 20])).toBe(true);
    const found = conflictsOf([
      at("a", "2026-11-16T09:00:00Z", "2026-11-16T10:00:00Z"),
      at("b", "2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z"),
    ]);
    expect(found.size).toBe(0);
  });

  it("finds partial and nested overlaps in both directions", () => {
    const found = conflictsOf([
      at("outer", "2026-11-16T09:00:00Z", "2026-11-16T12:00:00Z"),
      at("inner", "2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z"),
      at("partial", "2026-11-16T11:30:00Z", "2026-11-16T13:00:00Z"),
      at("alone", "2026-11-16T15:00:00Z", "2026-11-16T16:00:00Z"),
    ]);
    expect(found.get("outer")?.map((i) => i.id)).toEqual(["inner", "partial"]);
    expect(found.get("inner")?.map((i) => i.id)).toEqual(["outer"]);
    expect(found.get("partial")?.map((i) => i.id)).toEqual(["outer"]);
    expect(found.has("alone")).toBe(false);
  });

  it("never counts all-day events as conflicts", () => {
    const found = conflictsOf([
      item({
        id: "day",
        allDay: true,
        startDate: "2026-11-16",
        endDate: "2026-11-17",
      }),
      at("a", "2026-11-16T09:00:00Z", "2026-11-16T10:00:00Z"),
    ]);
    expect(found.size).toBe(0);
  });
});

describe("availability", () => {
  const win = workWindow("2026-11-16", NY, "09:00", "17:00");

  it("merges overlapping items and ignores all-day events", () => {
    const { freeMs } = availability(
      [
        at("a", "2026-11-16T15:00:00Z", "2026-11-16T16:00:00Z"),
        at("b", "2026-11-16T15:30:00Z", "2026-11-16T17:00:00Z"),
        item({
          id: "day",
          allDay: true,
          startDate: "2026-11-16",
          endDate: "2026-11-17",
        }),
      ],
      win,
    );
    // 09:00-17:00 New York is 8 h, and 10:00-12:00 there is busy.
    expect(freeMs).toBe(6 * HOUR);
  });

  it("starts no earlier than now", () => {
    const { free } = availability([], win, win[0] + 2 * HOUR);
    expect(free).toEqual([[win[0] + 2 * HOUR, win[1]]]);
  });

  it("counts real elapsed time across a spring-forward night", () => {
    const night = workWindow("2026-03-08", NY, "01:00", "05:00");
    expect((night[1] - night[0]) / HOUR).toBe(3);
    const { freeMs } = availability(
      [at("m", "2026-03-08T07:00:00Z", "2026-03-08T08:00:00Z")],
      night,
    );
    expect(freeMs).toBe(2 * HOUR);
  });

  it("counts real elapsed time across a fall-back night", () => {
    const night = workWindow("2026-11-01", NY, "00:00", "04:00");
    expect((night[1] - night[0]) / HOUR).toBe(5);
  });

  it("moves a time inside the spring-forward gap past it", () => {
    // 02:30 does not exist; it resolves to 03:30 EDT.
    expect(new Date(wallInstant("2026-03-08T02:30", NY)).toISOString()).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });
});
