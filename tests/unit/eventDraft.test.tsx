import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../src/database/events";
import {
  draftFromEvent,
  newDraft,
  toInput,
} from "../../src/features/calendar/eventDraft";

const stored: CalendarEvent = {
  id: "e1",
  calendarId: "c1",
  title: "Leave",
  description: "",
  location: null,
  url: null,
  allDay: true,
  startDate: "2026-12-30",
  endDate: "2027-01-02",
  timeZone: null,
  startLocal: null,
  endLocal: null,
  startAt: null,
  endAt: null,
  createdAt: "",
  updatedAt: "",
};

describe("event drafts", () => {
  it("shows an inclusive last day and stores an exclusive end", () => {
    const draft = draftFromEvent(stored, "Europe/Paris");
    expect([draft.startDate, draft.endDate]).toEqual([
      "2026-12-30",
      "2027-01-01",
    ]);
    expect(toInput(draft).input).toMatchObject({
      allDay: true,
      startDate: "2026-12-30",
      endDate: "2027-01-02",
    });
    // A one-day event ends the next day.
    expect(
      toInput({ ...draft, startDate: "2028-02-29", endDate: "2028-02-29" })
        .input,
    ).toMatchObject({ startDate: "2028-02-29", endDate: "2028-03-01" });
  });

  it("builds timed input in the chosen zone and keeps optional fields absent", () => {
    const draft = {
      ...newDraft("2026-11-18", "Asia/Tokyo", "c1"),
      title: "  Call  ",
      location: "  ",
    };
    expect(toInput(draft).input).toEqual({
      calendarId: "c1",
      title: "Call",
      description: "",
      location: null,
      url: null,
      allDay: false,
      timeZone: "Asia/Tokyo",
      start: "2026-11-18T09:00",
      end: "2026-11-18T10:00",
    });
    // A late start ends on the next day.
    const late = newDraft("2026-12-31", "UTC", "c1", "23:30", "00:30");
    expect([late.endDate, late.endTime]).toEqual(["2027-01-01", "00:30"]);
  });

  it("explains invalid drafts instead of sending them", () => {
    const draft = { ...newDraft("2026-11-18", "UTC", "c1"), title: "A" };
    expect(toInput({ ...draft, title: " " }).error).toBe("Enter a title.");
    expect(toInput({ ...draft, endTime: "09:00" }).error).toBe(
      "End after the start.",
    );
    expect(toInput({ ...draft, startTime: "" }).error).toBe(
      "Enter a start and end time.",
    );
    expect(
      toInput({ ...draft, allDay: true, endDate: "2026-11-17" }).error,
    ).toBe("End on or after the start date.");
  });
});
