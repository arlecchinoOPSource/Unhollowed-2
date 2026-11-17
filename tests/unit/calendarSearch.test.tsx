import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CalendarItem,
  CalendarSearchResults,
} from "../../src/database/events";
import { searchCalendarItems } from "../../src/database/events";
import { CalendarSearch } from "../../src/features/calendar/CalendarSearch";
import {
  defaultSearch,
  isFiltered,
  itemDate,
  searchInput,
  toggleCalendar,
  toggleKind,
  type SearchState,
} from "../../src/features/calendar/searchState";

vi.mock("../../src/database/events", async (original) => ({
  ...(await original<typeof import("../../src/database/events")>()),
  searchCalendarItems: vi.fn(),
}));

function item(id: string, title: string, date: string): CalendarItem {
  return {
    kind: "event",
    id,
    eventId: id,
    occurrence: null,
    recurring: false,
    title,
    calendarId: "c1",
    color: "blue",
    issueId: null,
    issueNumber: null,
    closed: false,
    allDay: true,
    startDate: date,
    endDate: date,
    start: null,
    end: null,
    startAt: null,
    endAt: null,
    timeZone: null,
    localStart: null,
    localEnd: null,
  };
}

function results(...items: CalendarItem[]): CalendarSearchResults {
  return { items, upcoming: items.length, truncated: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("search state", () => {
  it("combines kind, calendar, and completed filters and clears to the default", () => {
    let state: SearchState = defaultSearch;
    expect(isFiltered(state)).toBe(false);
    state = toggleKind(state, "deadline");
    expect(state.kinds).toEqual(["event", "workBlock"]);
    expect(isFiltered(state)).toBe(true);
    state = toggleKind(state, "deadline");
    expect(state.kinds).toEqual(["event", "deadline", "workBlock"]);

    const all = ["a", "b", "c"];
    state = toggleCalendar(state, "b", all);
    expect(state.calendarIds).toEqual(["a", "c"]);
    state = toggleCalendar(state, "b", all);
    // Every calendar checked again means "all", including future ones.
    expect(state.calendarIds).toBeNull();
    expect(isFiltered(state)).toBe(false);
  });

  it("sends only what narrows the search", () => {
    expect(searchInput(defaultSearch, "UTC", "2026-11-17")).toEqual({
      text: "",
      timeZone: "UTC",
      today: "2026-11-17",
      kinds: ["event", "deadline", "workBlock"],
      includeCompleted: false,
    });
    expect(
      searchInput({ ...defaultSearch, calendarIds: [] }, "UTC", "2026-11-17")
        .calendarIds,
    ).toEqual([]);
  });

  it("finds the day to show for timed and all-day items", () => {
    expect(itemDate(item("a", "A", "2026-12-03"))).toBe("2026-12-03");
    expect(
      itemDate({
        ...item("a", "A", "2026-12-03"),
        allDay: false,
        startDate: null,
        start: "2026-12-04T23:30",
      }),
    ).toBe("2026-12-04");
  });
});

describe("calendar search panel", () => {
  beforeEach(() => {
    vi.mocked(searchCalendarItems).mockReset();
  });
  afterEach(cleanup);

  function Harness({ onOpen }: { onOpen: (item: CalendarItem) => void }) {
    const [state, setState] = useState<SearchState>(defaultSearch);
    return (
      <CalendarSearch
        state={state}
        onChange={setState}
        calendars={[]}
        today="2026-11-17"
        zone="UTC"
        revision={0}
        onOpen={onOpen}
      />
    );
  }

  it("ignores a reply that arrives after a newer search", async () => {
    const first = deferred<CalendarSearchResults>();
    const second = deferred<CalendarSearchResults>();
    vi.mocked(searchCalendarItems)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<Harness onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /search calendar/i }));
    await waitFor(() => expect(searchCalendarItems).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "alpha" },
    });
    await waitFor(() => expect(searchCalendarItems).toHaveBeenCalledTimes(2));
    expect(vi.mocked(searchCalendarItems).mock.calls[1][0].text).toBe("alpha");

    await act(async () => {
      second.resolve(results(item("2", "Alpha review", "2026-12-01")));
    });
    await act(async () => {
      first.resolve(results(item("1", "Stale result", "2026-12-02")));
    });
    expect(screen.getByText("Alpha review")).toBeTruthy();
    expect(screen.queryByText("Stale result")).toBeNull();
  });

  it("selects with the arrow keys and opens the chosen result with Enter", async () => {
    vi.mocked(searchCalendarItems).mockResolvedValue(
      results(
        item("1", "First", "2026-12-01"),
        item("2", "Second", "2026-12-02"),
      ),
    );
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /search calendar/i }));
    const box = await screen.findByRole("combobox");
    await screen.findByText("Second");
    expect(box.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0].id,
    );
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    // Selection wraps from the first result to the last.
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("says when nothing matches, and Escape clears the text before closing", async () => {
    vi.mocked(searchCalendarItems).mockResolvedValue(results());
    render(<Harness onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /search calendar/i }));
    const box = await screen.findByRole("combobox");
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(await screen.findByText("No matching calendar items.")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    expect((box as HTMLInputElement).value).toBe("");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows a failure instead of stale results", async () => {
    vi.mocked(searchCalendarItems).mockRejectedValue({
      code: "storage_failed",
    });
    render(<Harness onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /search calendar/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("search");
  });
});
