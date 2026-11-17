import type {
  CalendarItem,
  CalendarSearchInput,
  ItemKind,
} from "../../database/events";

export const itemKinds: [ItemKind, string][] = [
  ["event", "Events"],
  ["deadline", "Deadlines"],
  ["workBlock", "Work blocks"],
];

/** The calendar search the user has built up. It outlives view changes. */
export interface SearchState {
  text: string;
  kinds: ItemKind[];
  /** `null` means every calendar, so new calendars are included too. */
  calendarIds: string[] | null;
  includeCompleted: boolean;
}

export const defaultSearch: SearchState = {
  text: "",
  kinds: itemKinds.map(([kind]) => kind),
  calendarIds: null,
  includeCompleted: false,
};

/** Whether any filter, ignoring the text, differs from the default. */
export function isFiltered(state: SearchState): boolean {
  return (
    state.includeCompleted !== defaultSearch.includeCompleted ||
    state.calendarIds !== null ||
    state.kinds.length !== defaultSearch.kinds.length
  );
}

export function toggleKind(state: SearchState, kind: ItemKind): SearchState {
  const kinds = state.kinds.includes(kind)
    ? state.kinds.filter((value) => value !== kind)
    : defaultSearch.kinds.filter(
        (value) => value === kind || state.kinds.includes(value),
      );
  return { ...state, kinds };
}

/**
 * Checks or unchecks one calendar. Checking the last unchecked calendar goes
 * back to "every calendar", so a calendar made later is included as well.
 */
export function toggleCalendar(
  state: SearchState,
  id: string,
  all: string[],
): SearchState {
  const current = state.calendarIds ?? all;
  const next = current.includes(id)
    ? current.filter((value) => value !== id)
    : all.filter((value) => value === id || current.includes(value));
  return {
    ...state,
    calendarIds: next.length === all.length ? null : next,
  };
}

export function searchInput(
  state: SearchState,
  timeZone: string,
  today: string,
): CalendarSearchInput {
  return {
    text: state.text,
    timeZone,
    today,
    kinds: state.kinds,
    ...(state.calendarIds ? { calendarIds: state.calendarIds } : {}),
    includeCompleted: state.includeCompleted,
  };
}

/** The calendar day an item belongs on, in the viewer's zone. */
export function itemDate(item: CalendarItem): string {
  return (item.allDay ? item.startDate : item.start?.slice(0, 10)) ?? "";
}
