import { useCallback, useState } from "react";

/**
 * Calendar display settings. The views take them as a value, so personal
 * preferences (U2-P3-08) can supply them; until then they are the defaults,
 * with the grid increment remembered on this device.
 */
export interface CalendarSettings {
  /** First day of the week: 0 Sunday to 6 Saturday. */
  weekStart: number;
  /** Days shown by Workweek and treated as working days: 0 Sunday to 6. */
  workDays: number[];
  /** Working hours, `HH:MM`, end exclusive. */
  workStart: string;
  workEnd: string;
  /** Minutes between grid lines. */
  increment: 15 | 30 | 60;
}

export const defaultSettings: CalendarSettings = {
  weekStart: 1,
  workDays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "17:00",
  increment: 30,
};

export const increments = [15, 30, 60] as const;

const KEY = "unhollowed-2-calendar";

function read(): CalendarSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as {
      increment?: number;
    };
    const increment = increments.find((value) => value === stored.increment);
    return { ...defaultSettings, ...(increment ? { increment } : {}) };
  } catch {
    return defaultSettings;
  }
}

/** The settings, and a way to change the grid increment. */
export function useCalendarSettings(): [
  CalendarSettings,
  (increment: CalendarSettings["increment"]) => void,
] {
  const [settings, setSettings] = useState(read);
  const setIncrement = useCallback(
    (increment: CalendarSettings["increment"]) => {
      setSettings((current) => ({ ...current, increment }));
      try {
        localStorage.setItem(KEY, JSON.stringify({ increment }));
      } catch {
        // Remembering the grid is a convenience; the view still works.
      }
    },
    [],
  );
  return [settings, setIncrement];
}
