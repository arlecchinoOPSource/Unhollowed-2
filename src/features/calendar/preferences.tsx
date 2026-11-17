import { createContext, useContext, useState } from "react";
import { useSearchParams } from "react-router";
import { localDate, parseLocalDate } from "../today/dates";
import { monthOf } from "./monthGrid";
import { defaultSettings, increments, type CalendarSettings } from "./settings";
import type { CalendarView } from "./ViewSwitch";

const key = "unhollowed-2-calendar";
export const viewNames = [
  "day",
  "week",
  "workweek",
  "month",
  "agenda",
] as const;
const names = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
type Preferences = CalendarSettings & {
  view: CalendarView;
  twelveHour: boolean;
  /** Warn in the event editor when an event overlaps another. */
  warnOverlaps: boolean;
};
const defaults: Preferences = {
  ...defaultSettings,
  view: "week",
  twelveHour: false,
  warnOverlaps: true,
};

export function validDate(value: string | null): value is string {
  return (
    !!value &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= "0001-01-01" &&
    localDate(parseLocalDate(value)) === value
  );
}

function read(): Preferences {
  try {
    const value = JSON.parse(
      localStorage.getItem(key) ?? "{}",
    ) as Partial<Preferences> & { version?: number };
    if (value.version !== undefined && value.version !== 1) return defaults;
    const workDays = Array.isArray(value.workDays)
      ? [...new Set(value.workDays)].filter(
          (day) => Number.isInteger(day) && day >= 0 && day <= 6,
        )
      : [];
    const hours = /^([01]\d|2[0-3]):[0-5]\d$/;
    const validHours =
      typeof value.workStart === "string" &&
      typeof value.workEnd === "string" &&
      hours.test(value.workStart) &&
      hours.test(value.workEnd) &&
      value.workStart < value.workEnd;
    return {
      weekStart:
        Number.isInteger(value.weekStart) && names[value.weekStart ?? -1]
          ? value.weekStart!
          : defaults.weekStart,
      workDays: workDays.length
        ? workDays.sort((a, b) => a - b)
        : defaults.workDays,
      workStart: validHours ? value.workStart! : defaults.workStart,
      workEnd: validHours ? value.workEnd! : defaults.workEnd,
      increment:
        increments.find((item) => item === value.increment) ??
        defaults.increment,
      view:
        value.view && viewNames.includes(value.view)
          ? value.view
          : defaults.view,
      twelveHour: value.twelveHour === true,
      warnOverlaps: value.warnOverlaps !== false,
    };
  } catch {
    return defaults;
  }
}

export const CalendarPreferences = createContext(defaults);
export function useCalendarPreferences() {
  return useContext(CalendarPreferences);
}

export function usePreferenceState() {
  const [settings, set] = useState(read);
  const [error, setError] = useState("");
  function save(next: Preferences) {
    set(next);
    try {
      localStorage.setItem(key, JSON.stringify({ version: 1, ...next }));
      setError("");
    } catch {
      setError("Preferences could not be saved to this device.");
    }
  }
  return { settings, save, error };
}

export function PreferenceControls({
  current,
  save,
  error,
}: {
  current: Preferences;
  save: (next: Preferences) => void;
  error: string;
}) {
  const [edits, setDraft] = useState<Partial<Preferences>>({});
  const draft = { ...current, ...edits };
  function change(patch: Partial<Preferences>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }
  const valid =
    !!draft.workDays.length &&
    !!draft.workStart &&
    !!draft.workEnd &&
    draft.workStart < draft.workEnd;
  return (
    <details className="calendar-preferences">
      <summary>Calendar preferences</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            save(draft);
            setDraft({});
          }
        }}
      >
        <label>
          Default view{" "}
          <select
            value={draft.view}
            onChange={(e) => change({ view: e.target.value as CalendarView })}
          >
            {viewNames.map((view) => (
              <option key={view} value={view}>
                {view === "workweek"
                  ? "Workweek"
                  : view[0].toUpperCase() + view.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          First day of week{" "}
          <select
            value={draft.weekStart}
            onChange={(e) => change({ weekStart: Number(e.target.value) })}
          >
            {names.map((day, index) => (
              <option key={day} value={index}>
                {day}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Working days</legend>
          {names.map((day, index) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={draft.workDays.includes(index)}
                onChange={(e) =>
                  change({
                    workDays: e.target.checked
                      ? [...draft.workDays, index].sort((a, b) => a - b)
                      : draft.workDays.filter((n) => n !== index),
                  })
                }
              />
              {day}
            </label>
          ))}
        </fieldset>
        <label>
          Working hours start{" "}
          <input
            type="time"
            value={draft.workStart}
            onChange={(e) => change({ workStart: e.target.value })}
          />
        </label>
        <label>
          Working hours end{" "}
          <input
            type="time"
            value={draft.workEnd}
            onChange={(e) => change({ workEnd: e.target.value })}
          />
        </label>
        <label>
          Time format{" "}
          <select
            value={draft.twelveHour ? "12" : "24"}
            onChange={(e) => change({ twelveHour: e.target.value === "12" })}
          >
            <option value="12">12 hour</option>
            <option value="24">24 hour</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.warnOverlaps}
            onChange={(e) => change({ warnOverlaps: e.target.checked })}
          />{" "}
          Warn when an event overlaps another
        </label>
        <label>
          Time grid{" "}
          <select
            value={draft.increment}
            onChange={(e) =>
              change({
                increment: Number(
                  e.target.value,
                ) as CalendarSettings["increment"],
              })
            }
          >
            {increments.map((n) => (
              <option key={n} value={n}>
                {n} minutes
              </option>
            ))}
          </select>
        </label>
        {!valid && (
          <p>
            Choose at least one working day and an end time after the start.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={!valid}>
          Save calendar preferences
        </button>
      </form>
    </details>
  );
}

export function DatePicker({ date, month }: { date: string; month?: boolean }) {
  const [params, setParams] = useSearchParams();
  return (
    <label>
      Go to date{" "}
      <input
        id="calendar-go-to-date"
        type="date"
        value={date}
        onChange={(event) => {
          const next = event.target.value;
          if (!validDate(next)) return;
          const updated = new URLSearchParams(params);
          updated.set("date", next);
          if (month) updated.set("month", monthOf(next));
          setParams(updated);
        }}
      />
    </label>
  );
}

export function displayClock(time: string, twelveHour: boolean) {
  if (!twelveHour) return time;
  const [hours, minutes] = time.split(":");
  const hour = Number(hours);
  return `${hour % 12 || 12}:${minutes} ${hour < 12 ? "AM" : "PM"}`;
}
