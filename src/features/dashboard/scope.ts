import { daysIn, presets, resolvePeriod, type Period } from "./controls";
import { parsePeriodConfig, widgetDefinition } from "./widgets";

/**
 * The period and filters a widget actually uses. A widget follows the
 * dashboard's period unless its saved config names its own; the dashboard's
 * project and habit filters are record choices that are never stored, so they
 * apply only where the widget's type declares it supports them.
 */
export interface Scope {
  period: Period;
  /** True when the widget's own period replaces the dashboard's. */
  own: boolean;
  /** For example "Last 7 days". */
  periodLabel: string;
  /** What the dashboard's project filter means for this widget. */
  project: "unused" | "applies" | "unsupported";
  habit: "unused" | "applies" | "unsupported";
}

export function effectiveScope(
  type: string,
  config: unknown,
  global: Period,
  today: string,
  filters: { project: boolean; habit: boolean },
  globalLabel: string,
): Scope {
  const definition = widgetDefinition(type);
  const supports = (name: "period" | "project" | "habit") =>
    definition?.filters.includes(name) ?? false;
  const override = supports("period")
    ? parsePeriodConfig(config)?.period
    : undefined;
  const period = override
    ? resolvePeriod(
        {
          preset: override.preset,
          custom: override.custom ?? global,
          hidden: [],
        },
        today,
      )
    : global;
  const label = override
    ? (presets.find(({ value }) => value === override.preset)?.label ?? "")
    : globalLabel;
  const state = (active: boolean, name: "project" | "habit") =>
    !active ? "unused" : supports(name) ? "applies" : "unsupported";
  return {
    period,
    own: override !== undefined,
    periodLabel: `${label} (${daysIn(period)} ${daysIn(period) === 1 ? "day" : "days"})`,
    project: state(filters.project, "project"),
    habit: state(filters.habit, "habit"),
  };
}
