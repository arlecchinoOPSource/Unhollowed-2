import type { DataSource } from "../../database/dataChanges";
import { periodProblem, presets, type Period, type Preset } from "./controls";

/**
 * The dashboard widget registry: one typed table that says which widgets
 * exist, what each reads, how it is configured, and how it is sized. It
 * holds no data and runs no queries. Each widget keeps using the analytics
 * contracts in docs/ANALYTICS.md, so a metric means the same thing wherever
 * it is shown. Types are fixed in code: there are no scripts and no external
 * widget plugins.
 */
export type WidgetFilter = "period" | "project" | "habit";

export interface WidgetSize {
  /** Columns of the 12-column grid. */
  w: number;
  /** Rows, in grid units. */
  h: number;
  minW: number;
  minH: number;
}

/**
 * A setting the user can change, described once here so the settings form is
 * generated from the contract and edits the same keys `parse` validates.
 */
export type FieldSpec =
  | { kind: "textarea"; key: string; label: string; max: number }
  | { kind: "destinations"; key: string; label: string; max: number }
  /** The widget's own period, or none to follow the dashboard's. */
  | { kind: "period"; key: string; label: string };

/** Places in the app a shortcut may open. */
export const DESTINATIONS: readonly Shortcut[] = [
  { label: "Home", to: "/" },
  { label: "Today", to: "/today" },
  { label: "Calendar", to: "/calendar" },
  { label: "Issues", to: "/issues" },
  { label: "Projects", to: "/projects" },
  { label: "Documents", to: "/documents" },
  { label: "Habits", to: "/habits" },
  { label: "Mood", to: "/mood" },
  { label: "Dashboards", to: "/dashboards" },
];

export interface WidgetDefinition<C extends object = object> {
  /** Stable type ID, stored in layouts. Never renamed or reused. */
  type: string;
  label: string;
  description: string;
  /** Version of this type's config shape. */
  version: number;
  /** Data sources whose changes refresh the widget. */
  sources: readonly DataSource[];
  /** The dashboard filters the widget honors. */
  filters: readonly WidgetFilter[];
  size: WidgetSize;
  /** The settings it offers; none means it has nothing to configure. */
  fields?: readonly FieldSpec[];
  /** What the widget says when its source has nothing to show. */
  empty: string;
  /** What the widget says when its source fails, beside a retry. */
  error: string;
  defaults: C;
  /** The valid config for stored input, or null when it cannot be used. */
  parse(raw: unknown): C | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Config that has no options: accepts nothing, or an object. */
const noOptions = (raw: unknown): Record<string, never> | null =>
  raw === undefined || (record(raw) && Object.keys(raw).length === 0)
    ? {}
    : null;

/** A period a widget keeps for itself instead of the dashboard's. */
export interface PeriodOverride {
  preset: Preset;
  /** Required for, and only for, the custom preset. */
  custom?: Period;
}
export interface PeriodConfig {
  period?: PeriodOverride;
}

/** Config for widgets that follow the dashboard period unless told otherwise. */
export function parsePeriodConfig(raw: unknown): PeriodConfig | null {
  if (raw === undefined || raw === null) return {};
  if (!record(raw) || !Object.keys(raw).every((key) => key === "period"))
    return null;
  if (raw.period === undefined) return {};
  const value = raw.period;
  if (
    !record(value) ||
    !Object.keys(value).every((key) => key === "preset" || key === "custom") ||
    !presets.some(({ value: preset }) => preset === value.preset)
  )
    return null;
  if (value.preset !== "custom")
    return value.custom === undefined
      ? { period: { preset: value.preset as Preset } }
      : null;
  const custom = value.custom;
  if (
    !record(custom) ||
    typeof custom.from !== "string" ||
    typeof custom.to !== "string" ||
    periodProblem({ from: custom.from, to: custom.to }) !== null
  )
    return null;
  return {
    period: { preset: "custom", custom: { from: custom.from, to: custom.to } },
  };
}

export const MAX_NOTE = 2000;
export const MAX_SHORTCUTS = 12;

export interface Shortcut {
  label: string;
  /** An in-app path. Anything else is refused, so no remote link can be saved. */
  to: string;
}

const internalPath = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\/(?!\/)[\w\-./?=&%#]*$/.test(value) &&
  value.length <= 200;

function make<C extends object>(
  definition: Omit<WidgetDefinition<C>, "version" | "size"> & {
    size: [number, number, number, number];
  },
): WidgetDefinition<C> {
  const [w, h, minW, minH] = definition.size;
  return { ...definition, version: 1, size: { w, h, minW, minH } };
}

const none = (
  type: string,
  label: string,
  description: string,
  sources: readonly DataSource[],
  filters: readonly WidgetFilter[],
  size: [number, number, number, number],
  empty: string,
) =>
  make({
    type,
    label,
    description,
    sources,
    filters,
    size,
    empty,
    error: "This widget could not read its data.",
    defaults: {},
    fields: filters.includes("period")
      ? [{ kind: "period", key: "period", label: "Period" }]
      : undefined,
    parse: (filters.includes("period") ? parsePeriodConfig : noOptions) as (
      raw: unknown,
    ) => object | null,
  });

const definitions: WidgetDefinition[] = [
  none(
    "stat-card",
    "Statistic cards",
    "Counts for issues, habits, and the calendar.",
    ["issues", "habits", "calendar"],
    ["period", "project"],
    [12, 2, 4, 2],
    "No activity in this period.",
  ),
  none(
    "line-chart",
    "Line chart",
    "A measure over time.",
    ["issues", "habits", "checkins", "calendar"],
    ["period", "project"],
    [6, 4, 4, 3],
    "No data in this period.",
  ),
  none(
    "bar-chart",
    "Bar chart",
    "A measure by day, week, or project.",
    ["issues", "habits", "calendar"],
    ["period", "project"],
    [6, 4, 4, 3],
    "No data in this period.",
  ),
  none(
    "heatmap",
    "Heatmap",
    "Habit completion by day.",
    ["habits"],
    ["period", "habit"],
    [12, 4, 6, 3],
    "No habits yet.",
  ),
  none(
    "issue-list",
    "Issue list",
    "Overdue and upcoming issues.",
    ["issues"],
    ["project"],
    [6, 4, 3, 3],
    "No issues to show.",
  ),
  none(
    "agenda-list",
    "Agenda",
    "Scheduled events and work sessions.",
    ["calendar", "issues"],
    ["period", "project"],
    [6, 4, 3, 3],
    "Nothing scheduled in this period.",
  ),
  none(
    "project-progress",
    "Project progress",
    "Issue and objective progress by project.",
    ["issues", "projects"],
    ["period", "project"],
    [12, 5, 6, 3],
    "No issues yet.",
  ),
  none(
    "milestone-progress",
    "Milestone progress",
    "Open and closed milestones.",
    ["milestones", "issues"],
    ["period", "project"],
    [6, 3, 3, 2],
    "No milestones yet.",
  ),
  none(
    "mood-trend",
    "Mood, energy, and focus",
    "Check-in averages. Hidden when nothing was recorded.",
    ["checkins"],
    ["period"],
    [12, 3, 4, 2],
    "No check-ins in this period.",
  ),
  make<{ text: string }>({
    type: "notes",
    label: "Notes",
    description: "Plain text kept on the dashboard.",
    sources: [],
    filters: [],
    size: [6, 3, 3, 2],
    empty: "Write a note.",
    error: "This note could not be shown.",
    fields: [{ kind: "textarea", key: "text", label: "Note", max: MAX_NOTE }],
    defaults: { text: "" },
    parse: (raw) =>
      record(raw) &&
      Object.keys(raw).every((key) => key === "text") &&
      typeof raw.text === "string" &&
      raw.text.length <= MAX_NOTE
        ? { text: raw.text }
        : raw === undefined
          ? { text: "" }
          : null,
  }),
  make<{ links: Shortcut[] }>({
    type: "shortcuts",
    label: "Shortcuts",
    description: "Links to places in the app.",
    sources: [],
    filters: [],
    size: [6, 2, 3, 2],
    empty: "Add a shortcut.",
    error: "These shortcuts could not be shown.",
    fields: [
      {
        kind: "destinations",
        key: "links",
        label: "Shortcuts",
        max: MAX_SHORTCUTS,
      },
    ],
    defaults: { links: [] },
    parse: (raw) => {
      if (raw === undefined) return { links: [] };
      if (!record(raw) || !Object.keys(raw).every((key) => key === "links"))
        return null;
      const links = raw.links;
      if (!Array.isArray(links) || links.length > MAX_SHORTCUTS) return null;
      const valid = links.every(
        (item) =>
          record(item) &&
          typeof item.label === "string" &&
          item.label.trim() !== "" &&
          item.label.length <= 60 &&
          internalPath(item.to),
      );
      return valid
        ? { links: links.map((i) => ({ label: i.label, to: i.to })) }
        : null;
    },
  }),
];

export const widgetTypes: readonly WidgetDefinition[] = definitions;

const byType = new Map(widgetTypes.map((item) => [item.type, item]));

export const widgetDefinition = (type: string) => byType.get(type);

/** A placed widget as stored in a layout. */
export interface WidgetInstance {
  /** Stable, unique within a layout. */
  id: string;
  type: string;
  /** The config version it was saved with. */
  version: number;
  config?: unknown;
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ResolvedWidget =
  | {
      status: "ready";
      definition: WidgetDefinition;
      config: object;
    }
  | {
      /** Config was missing, invalid, or from a newer version: defaults apply. */
      status: "repaired";
      definition: WidgetDefinition;
      config: object;
      reason: string;
    }
  | { status: "unknown"; type: string };

/**
 * What to show for a stored instance. Never throws: an unknown type is a
 * recoverable placeholder, and unusable config falls back to the defaults
 * with a reason, so one bad record never blanks the dashboard.
 */
export function resolveWidget(instance: WidgetInstance): ResolvedWidget {
  const definition = widgetDefinition(instance.type);
  if (!definition) return { status: "unknown", type: instance.type };
  if (instance.version !== definition.version)
    return {
      status: "repaired",
      definition,
      config: definition.defaults,
      reason: `Saved with settings version ${String(instance.version)}; showing defaults.`,
    };
  const config = definition.parse(instance.config);
  return config
    ? { status: "ready", definition, config }
    : {
        status: "repaired",
        definition,
        config: definition.defaults,
        reason: "Its saved settings were not valid; showing defaults.",
      };
}

/** Whether `size` is positive, whole, within 12 columns, and at least the minimum. */
export function sizeProblem(
  type: string,
  size: Pick<WidgetSize, "w" | "h">,
): string | null {
  const definition = widgetDefinition(type);
  if (!definition) return "Unknown widget type.";
  const whole = Number.isInteger(size.w) && Number.isInteger(size.h);
  if (!whole || size.w > 12) return "Size must be whole, up to 12 columns.";
  if (size.w < definition.size.minW || size.h < definition.size.minH)
    return "Smaller than this widget allows.";
  return null;
}

/** Layout list problems, or null: IDs must be well formed and unique. */
export function layoutProblem(instances: readonly WidgetInstance[]) {
  const seen = new Set<string>();
  for (const { id } of instances) {
    if (!ID_PATTERN.test(id)) return `"${id}" is not a valid widget ID.`;
    if (seen.has(id)) return `Widget ID "${id}" is used twice.`;
    seen.add(id);
  }
  return null;
}

/**
 * The Phase 4 dashboard as a layout. The instance IDs equal the section keys
 * the dashboard already saves as hidden sections, so existing preferences
 * keep working.
 */
export const defaultLayout: readonly WidgetInstance[] = [
  { id: "glance", type: "stat-card", version: 1 },
  { id: "progress", type: "project-progress", version: 1 },
  { id: "schedule", type: "agenda-list", version: 1 },
  { id: "habits", type: "heatmap", version: 1 },
  { id: "mood", type: "mood-trend", version: 1 },
];
