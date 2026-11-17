import { expect, test } from "vitest";
import type { CalendarItem } from "../../src/database/events";
import { proposedSpan } from "../../src/features/calendar/schedulingGesture";

const timed = {
  allDay: false,
  startAt: "2026-03-07T14:00:00Z",
  endAt: "2026-03-07T15:00:00Z",
  timeZone: "America/New_York",
} as CalendarItem;

test("preserves elapsed duration across a DST boundary and separate viewer zone", () => {
  expect(proposedSpan(timed, "2026-03-08", "14:00", "UTC", "move", 30)).toEqual(
    {
      start: "2026-03-08T10:00",
      end: "2026-03-08T11:00",
    },
  );
  expect(
    proposedSpan(timed, "2026-03-08", "02:30", "America/New_York", "move", 30),
  ).toBeUndefined();
});

test("rejects short resizes and preserves exclusive all-day lengths", () => {
  expect(
    proposedSpan(timed, "2026-03-07", "14:10", "UTC", "resize", 30),
  ).toBeUndefined();
  const allDay = {
    allDay: true,
    startDate: "2026-10-31",
    endDate: "2026-11-03",
  } as CalendarItem;
  expect(
    proposedSpan(allDay, "2026-12-31", "00:00", "America/New_York", "move", 30),
  ).toEqual({
    start: "2026-12-31",
    end: "2027-01-03",
  });
});
