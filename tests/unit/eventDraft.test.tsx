import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../src/database/events";
import {
  draftFromEvent,
  newDraft,
  seriesInput,
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
  repeatFreq: null,
  repeatInterval: null,
  repeatCount: null,
  repeatUntil: null,
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
      repeat: null,
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

  it("builds and checks repeat rules", () => {
    const draft = {
      ...newDraft("2026-11-02", "UTC", "c1"),
      title: "Class",
      repeatFreq: "weekly" as const,
      repeatInterval: "2",
      repeatEnd: "count" as const,
      repeatCount: "6",
    };
    expect(toInput(draft).input?.repeat).toEqual({
      freq: "weekly",
      interval: 2,
      count: 6,
      until: null,
    });
    expect(toInput({ ...draft, repeatInterval: "0" }).error).toBe(
      "Repeat every 1 to 99.",
    );
    expect(
      toInput({ ...draft, repeatEnd: "until", repeatUntil: "2026-11-01" })
        .error,
    ).toBe("End the repeat on or after the start date.");
    // A stored rule fills the draft back.
    const series = {
      ...stored,
      repeatFreq: "monthly" as const,
      repeatInterval: 1,
      repeatUntil: "2027-06-30",
    };
    expect(draftFromEvent(series, "UTC")).toMatchObject({
      repeatFreq: "monthly",
      repeatEnd: "until",
      repeatUntil: "2027-06-30",
    });
  });

  it("turns an occurrence edit into a series edit by the same shift", () => {
    const series = {
      ...stored,
      allDay: false,
      startDate: null,
      endDate: null,
      timeZone: "UTC",
      startLocal: "2026-11-02T09:00",
      endLocal: "2026-11-02T10:00",
      repeatFreq: "weekly" as const,
      repeatInterval: 1,
    };
    // The 30 November occurrence moved to 11:30–12:15 on 1 December.
    const moved = seriesInput(series, "2026-11-30T09:00", {
      title: "Class",
      description: "",
      location: null,
      url: null,
      allDay: false,
      timeZone: "UTC",
      start: "2026-12-01T11:30",
      end: "2026-12-01T12:15",
    });
    expect([moved.start, moved.end]).toEqual([
      "2026-11-03T11:30",
      "2026-11-03T12:15",
    ]);
    // All-day series shift by days across a month end.
    const days = seriesInput(
      { ...stored, repeatFreq: "weekly", repeatInterval: 1 },
      "2027-01-27",
      {
        title: "Leave",
        description: "",
        location: null,
        url: null,
        allDay: true,
        startDate: "2027-02-01",
        endDate: "2027-02-03",
      },
    );
    expect([days.startDate, days.endDate]).toEqual([
      "2027-01-04",
      "2027-01-06",
    ]);
  });
});
