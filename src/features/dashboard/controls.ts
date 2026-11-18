import { addDays, localDate, parseLocalDate } from "../today/dates";

/**
 * Dashboard controls: the period and which sections show. Pure, so the
 * ranges and the stored options can be tested without a page.
 *
 * A period is two local calendar days, both inclusive. The preferences saved
 * across restarts are display choices only (the period and the visible
 * sections). The project and habit filters are navigation state: they point
 * at records that can be deleted, so they start fresh each visit.
 */
export type Preset = "last7" | "last30" | "month" | "custom";

export const presets: { value: Preset; label: string }[] = [
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom dates" },
];

export const sections = [
  { key: "glance", label: "At a glance" },
  { key: "progress", label: "Projects and issues" },
  { key: "schedule", label: "Schedule" },
  { key: "habits", label: "Habits" },
  { key: "mood", label: "Mood, energy, and focus" },
] as const;
export type SectionKey = (typeof sections)[number]["key"];

export interface Period {
  from: string;
  to: string;
}

export interface Preferences {
  preset: Preset;
  /** Used only by the custom preset. */
  custom: Period;
  /** IDs of the widgets the user turned off. */
  hidden: string[];
}

/** The longest period the analytics accept, in days. */
export const MAX_DAYS = 366;
export const defaults = (today: string): Preferences => ({
  preset: "last30",
  custom: { from: addDays(today, -29), to: today },
  hidden: [],
});

const STORAGE_KEY = "unhollowed-2-dashboard";
const VERSION = 1;

/** A real calendar day written exactly as YYYY-MM-DD, from year 1900. */
export function validDay(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= "1900-01-01" &&
    localDate(parseLocalDate(value)) === value
  );
}

/** Whole days from `from` to `to`, inclusive. */
export function daysIn(period: Period): number {
  const span =
    parseLocalDate(period.to).getTime() - parseLocalDate(period.from).getTime();
  // Rounding absorbs the hour a daylight-saving change adds or removes.
  return Math.round(span / 86_400_000) + 1;
}

/** Why a custom period cannot be used, or null when it can. */
export function periodProblem(period: Period): string | null {
  if (!validDay(period.from) || !validDay(period.to))
    return "Enter both dates.";
  if (period.from > period.to) return "The start must be on or before the end.";
  if (daysIn(period) > MAX_DAYS) return `Choose at most ${MAX_DAYS} days.`;
  return null;
}

/**
 * The inclusive range a preset means on `today`. "This month" is the whole
 * calendar month, and the analytics count through today only. A custom range
 * that cannot be used falls back to the last 30 days, so the page always has
 * a valid period.
 */
export function resolvePeriod(prefs: Preferences, today: string): Period {
  switch (prefs.preset) {
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "last30":
      return { from: addDays(today, -29), to: today };
    case "month": {
      const [year, month] = today.split("-").map(Number);
      const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
      return { from: first, to: localDate(new Date(year, month, 1), -1) };
    }
    case "custom":
      return periodProblem(prefs.custom) === null
        ? { ...prefs.custom }
        : { from: addDays(today, -29), to: today };
  }
}

/** Saved preferences, with anything unusable replaced by its default. */
export function readPreferences(today: string): Preferences {
  const fallback = defaults(today);
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof stored !== "object" || stored === null) return fallback;
    if (stored.version !== undefined && stored.version !== VERSION)
      return fallback;
    const known = new Set<string>(sections.map(({ key }) => key));
    const custom = {
      from: stored.custom?.from,
      to: stored.custom?.to,
    };
    return {
      preset: presets.some(({ value }) => value === stored.preset)
        ? stored.preset
        : fallback.preset,
      custom: periodProblem(custom) === null ? custom : fallback.custom,
      hidden: Array.isArray(stored.hidden)
        ? [...new Set<string>(stored.hidden)].filter((key): key is SectionKey =>
            known.has(key),
          )
        : [],
    };
  } catch {
    return fallback;
  }
}

export function writePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: VERSION, ...prefs }),
    );
  } catch {
    // Storage can be unavailable; the choices then last for this visit only.
  }
}
