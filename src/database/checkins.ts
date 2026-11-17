import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers for the check-in commands in `src-tauri/src/checkins.rs`.
 * Dates are local `YYYY-MM-DD` days. A rating is 1 to 5 or null: unset is
 * never filled in. See docs/DATA_MODEL.md, "Daily check-ins".
 */
export interface Checkin {
  id: string;
  date: string;
  mood: number | null;
  energy: number | null;
  focus: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CheckinInput {
  mood: number | null;
  energy: number | null;
  focus: number | null;
  note: string | null;
}

export const getCheckin = (date: string): Promise<Checkin | null> =>
  invoke("get_checkin", { date });

/** Check-ins from `from` through `to`, oldest first; days without one are absent. */
export const listCheckins = (from: string, to: string): Promise<Checkin[]> =>
  invoke("list_checkins", { from, to });

/**
 * Replaces the day's check-in. With no rating and a blank note nothing is
 * kept: the day's record is removed and this resolves with null.
 */
export const saveCheckin = (
  date: string,
  input: CheckinInput,
): Promise<Checkin | null> => invoke("save_checkin", { date, ...input });

export const deleteCheckin = (date: string): Promise<void> =>
  invoke("delete_checkin", { date });

export function checkinError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  switch (code) {
    case "invalid_date":
      return "Use a valid calendar date.";
    case "future_date":
      return "A check-in cannot be saved for a day that has not happened.";
    case "invalid_rating":
      return "Ratings are whole numbers from 1 to 5.";
    case "note_too_long":
      return "Notes can have up to 2000 characters.";
    case "invalid_range":
      return "Choose a start on or before the end, within ten years.";
    default:
      return "Could not save to local storage. Try again.";
  }
}
