import {
  defaults,
  periodProblem,
  presets,
  readPreferences,
  type Period,
  type Preset,
} from "./controls";
import {
  defaultLayout as phase4Widgets,
  ID_PATTERN,
  widgetDefinition,
} from "./widgets";

/**
 * A saved dashboard layout, version 1: the period it shows and its widget
 * instances with position and size on the 12-column grid. It holds no
 * analytics values. `readLayout` never throws and never discards a widget it
 * can keep, so a hand-edited or newer record degrades instead of failing.
 */
export interface PlacedWidget {
  id: string;
  type: string;
  version: number;
  config: object | null;
  hidden: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardLayout {
  version: 1;
  preferences: { preset: Preset; custom: Period };
  widgets: PlacedWidget[];
}

export const GRID = 12;
export const MAX_WIDGETS = 60;

/** The Phase 4 dashboard: five full-width sections, stacked. */
export function defaultDashboard(today: string): DashboardLayout {
  const { preset, custom } = defaults(today);
  let y = 0;
  const widgets = phase4Widgets.map((instance): PlacedWidget => {
    const size = widgetDefinition(instance.type)!.size;
    const placed = {
      id: instance.id,
      type: instance.type,
      version: instance.version,
      config: null,
      hidden: false,
      x: 0,
      y,
      w: GRID,
      h: size.h,
    };
    y += size.h;
    return placed;
  });
  return { version: 1, preferences: { preset, custom }, widgets };
}

/**
 * Carries the choices Phase 4 kept in this browser (period and hidden
 * sections) into a first layout. Only supported values survive; the stored
 * record is left in place and never read again once a dashboard exists.
 */
export function layoutFromLegacy(today: string): DashboardLayout {
  const prefs = readPreferences(today);
  const base = defaultDashboard(today);
  return {
    ...base,
    preferences: { preset: prefs.preset, custom: prefs.custom },
    widgets: base.widgets.map((widget) => ({
      ...widget,
      hidden: prefs.hidden.includes(widget.id as never),
    })),
  };
}

export type Recovery = "ok" | "repaired" | "malformed" | "newer";

export interface Reading {
  layout: DashboardLayout;
  recovery: Recovery;
  /** Plain-language notes on what was repaired or dropped. */
  notes: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const whole = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : null;

/**
 * Turns a stored record into a layout to show.
 * - A newer version is shown as the default layout and must not be saved over
 *   (`recovery: "newer"`): the stored record stays as the newer release wrote it.
 * - An unreadable record shows the default layout (`"malformed"`).
 * - A readable one is repaired field by field: bad period values take their
 *   defaults, sizes are clamped to the grid, widgets with unusable or repeated
 *   IDs are dropped, and widgets of unknown types are kept as they are.
 */
export function readLayout(
  raw: unknown,
  version: number,
  today: string,
): Reading {
  const fallback = defaultDashboard(today);
  if (version > 1)
    return {
      layout: fallback,
      recovery: "newer",
      notes: ["Saved by a newer version of the app; showing the default."],
    };
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.widgets))
    return {
      layout: fallback,
      recovery: "malformed",
      notes: ["The saved layout could not be read; showing the default."],
    };
  const notes: string[] = [];

  const prefs = record(raw.preferences) ? raw.preferences : {};
  const custom = record(prefs.custom)
    ? { from: String(prefs.custom.from), to: String(prefs.custom.to) }
    : fallback.preferences.custom;
  const preset = presets.some(({ value }) => value === prefs.preset)
    ? (prefs.preset as Preset)
    : fallback.preferences.preset;
  const goodCustom = periodProblem(custom) === null;
  if (preset !== prefs.preset || !goodCustom)
    notes.push("Some period settings were reset.");

  const seen = new Set<string>();
  const widgets: PlacedWidget[] = [];
  for (const item of raw.widgets.slice(0, MAX_WIDGETS)) {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      !ID_PATTERN.test(item.id) ||
      seen.has(item.id) ||
      typeof item.type !== "string" ||
      !ID_PATTERN.test(item.type)
    ) {
      notes.push("A widget with an unusable ID or type was dropped.");
      continue;
    }
    seen.add(item.id);
    const w = whole(item.w, 1, GRID) ?? GRID;
    const x = whole(item.x, 0, GRID - w) ?? 0;
    const y = whole(item.y, 0, 999) ?? 0;
    const h = whole(item.h, 1, 40) ?? 3;
    const exact = w === item.w && x === item.x && y === item.y && h === item.h;
    if (!exact) notes.push(`Widget "${item.id}" was moved or resized to fit.`);
    widgets.push({
      id: item.id,
      type: item.type,
      version: whole(item.version, 1, 1000) ?? 1,
      config: record(item.config) ? item.config : null,
      hidden: item.hidden === true,
      x,
      y,
      w,
      h,
    });
  }
  if (raw.widgets.length > MAX_WIDGETS)
    notes.push("Widgets beyond the limit were dropped.");
  return {
    layout: {
      version: 1,
      preferences: {
        preset,
        custom: goodCustom ? custom : fallback.preferences.custom,
      },
      widgets,
    },
    recovery: notes.length ? "repaired" : "ok",
    notes,
  };
}

/** The widgets in reading order: top to bottom, then left to right. */
export const ordered = (widgets: readonly PlacedWidget[]) =>
  [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);

/** A unique, well-formed ID for a new instance of `type`. */
export function newWidgetId(
  type: string,
  existing: readonly { id: string }[],
): string {
  const taken = new Set(existing.map((item) => item.id));
  for (let n = 1; ; n++) {
    const id = `${type}-${n}`.slice(0, 64);
    if (!taken.has(id)) return id;
  }
}

/** The same widgets with fresh instance IDs, for a copy of a dashboard. */
export function withNewIds(widgets: readonly PlacedWidget[]): PlacedWidget[] {
  const made: PlacedWidget[] = [];
  for (const widget of widgets)
    made.push({ ...widget, id: newWidgetId(widget.type, made) });
  return made;
}
