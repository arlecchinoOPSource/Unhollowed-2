import type { ReactNode } from "react";
import type { Period } from "./controls";
import { GlanceSection } from "./GlanceSection";
import { HabitsSection } from "./HabitsSection";
import { MoodSection } from "./MoodSection";
import { ProgressSection } from "./ProgressSection";
import { ScheduleSection } from "./ScheduleSection";
import { resolveWidget, type WidgetInstance } from "./widgets";

export interface WidgetContext {
  project: string | null;
  habit: string | null;
  period: Period;
}

type Renderer = (context: WidgetContext) => ReactNode;

/**
 * Widgets that render today. They are the Phase 4 sections, unchanged and
 * still reading their own analytics contracts. A registered type with no
 * renderer yet shows a notice instead of failing.
 */
const renderers: Record<string, Renderer> = {
  "stat-card": ({ project, period }) => (
    <GlanceSection project={project} period={period} />
  ),
  "project-progress": ({ project, period }) => (
    <ProgressSection project={project} period={period} />
  ),
  "agenda-list": ({ project, period }) => (
    <ScheduleSection project={project} period={period} />
  ),
  heatmap: ({ project, habit, period }) => (
    <HabitsSection project={project} habit={habit} period={period} />
  ),
  "mood-trend": ({ project, period }) => (
    <MoodSection project={project} period={period} />
  ),
};

/** One widget: resolves the instance and shows it or a safe fallback. */
export function WidgetHost({
  instance,
  context,
}: {
  instance: WidgetInstance;
  context: WidgetContext;
}) {
  const resolved = resolveWidget(instance);
  if (resolved.status === "unknown")
    return (
      <section className="dash-section" data-widget={instance.id}>
        <p role="status">
          This widget type ("{resolved.type}") is not available in this version.
          Your layout is kept.
        </p>
      </section>
    );
  const render = renderers[resolved.definition.type];
  if (!render)
    return (
      <section className="dash-section" data-widget={instance.id}>
        <h2>{resolved.definition.label}</h2>
        <p role="status">This widget is not available yet.</p>
      </section>
    );
  return (
    <>
      {resolved.status === "repaired" && (
        <p role="status" data-widget-notice={instance.id}>
          {resolved.definition.label}: {resolved.reason}
        </p>
      )}
      {render(context)}
    </>
  );
}
