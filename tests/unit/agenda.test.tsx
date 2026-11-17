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
