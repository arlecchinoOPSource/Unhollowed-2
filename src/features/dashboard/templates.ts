import { settle } from "./grid";
import { defaultDashboard, newWidgetId, type DashboardLayout } from "./layout";
import type { PlacedWidget } from "./layout";
import { widgetDefinition, type Shortcut } from "./widgets";

/**
 * Starter dashboards. A template is only a list of registry widget types with
 * a width and column, turned into the ordinary layout format, so it is
 * validated, saved, and edited exactly like a dashboard the user built.
 */
interface Slot {
  type: string;
  w?: number;
  x?: number;
  config?: object;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  slots: readonly Slot[];
}

const go = (...labels: string[]): { links: Shortcut[] } => ({
  links: labels.map((label) => ({
    label,
    to: `/${{ Home: "", Today: "today", Calendar: "calendar", Issues: "issues", Projects: "projects", Documents: "documents", Habits: "habits", Mood: "mood" }[label]}`,
  })),
});

export const templates: readonly Template[] = [
  {
    id: "general",
    name: "General Productivity",
    description: "Progress, schedule, habits, and mood in one place.",
    slots: [
      { type: "stat-card" },
      { type: "project-progress" },
      { type: "agenda-list" },
      { type: "heatmap" },
      { type: "mood-trend" },
    ],
  },
  {
    id: "student",
    name: "Student Workspace",
    description: "Deadlines, study habits, and quick notes.",
    slots: [
      { type: "stat-card" },
      { type: "agenda-list", w: 6 },
      { type: "project-progress", w: 6, x: 6 },
      { type: "heatmap" },
      { type: "notes", w: 6 },
      {
        type: "shortcuts",
        w: 6,
        x: 6,
        config: go("Calendar", "Documents", "Issues"),
      },
    ],
  },
  {
    id: "project",
    name: "Project Management",
    description: "Project and issue progress with the schedule beside it.",
    slots: [
      { type: "stat-card" },
      { type: "project-progress" },
      { type: "agenda-list", w: 6 },
      {
        type: "shortcuts",
        w: 6,
        x: 6,
        config: go("Projects", "Issues", "Calendar"),
      },
    ],
  },
  {
    id: "personal",
    name: "Personal Development",
    description: "Habits and mood first, with room to reflect.",
    slots: [
      { type: "stat-card" },
      { type: "heatmap" },
      { type: "mood-trend", w: 6 },
      {
        type: "notes",
        w: 6,
        x: 6,
        config: { text: "What went well this week?" },
      },
      { type: "shortcuts", config: go("Habits", "Mood") },
    ],
  },
];

export const defaultTemplate = templates[0];

/**
 * A new layout from a template: fresh instance IDs, the registry's default
 * sizes, and the Phase 4 period defaults. Calling it twice gives two
 * dashboards that share nothing.
 */
export function fromTemplate(
  template: Template,
  today: string,
): DashboardLayout {
  const widgets: PlacedWidget[] = [];
  template.slots.forEach((slot, index) => {
    const definition = widgetDefinition(slot.type)!;
    widgets.push({
      id: newWidgetId(slot.type, widgets),
      type: slot.type,
      version: definition.version,
      config:
        slot.config ??
        (Object.keys(definition.defaults).length ? definition.defaults : null),
      hidden: false,
      x: slot.x ?? 0,
      y: index * 100,
      w: slot.w ?? 12,
      h: definition.size.h,
    });
  });
  return {
    ...defaultDashboard(today),
    widgets: settle(widgets),
  };
}
