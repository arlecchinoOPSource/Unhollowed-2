import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Period } from "./controls";
import { GlanceSection } from "./GlanceSection";
import { HabitsSection } from "./HabitsSection";
import { ChartWidget } from "./ChartWidget";
import { ComparisonWidget } from "./ComparisonWidget";
import { InsightsWidget } from "./InsightsWidget";
import { MoodSection } from "./MoodSection";
import { ProgressSection } from "./ProgressSection";
import { ScheduleSection } from "./ScheduleSection";
import { resolveWidget, type Shortcut, type WidgetInstance } from "./widgets";

export interface WidgetContext {
  project: string | null;
  habit: string | null;
  period: Period;
}

type Renderer = (context: WidgetContext, config: object) => ReactNode;

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
  "line-chart": (context, config) => (
    <ChartWidget
      kind="line"
      metric={(config as { metric: string }).metric}
      context={context}
    />
  ),
  "bar-chart": (context, config) => (
    <ChartWidget
      kind="bar"
      metric={(config as { metric: string }).metric}
      context={context}
    />
  ),
  comparison: (context, config) => (
    <ComparisonWidget
      grain={(config as { grain: "week" | "month" }).grain}
      context={context}
    />
  ),
  insights: (context) => <InsightsWidget context={context} />,
  notes: (_, config) => {
    const { text } = config as { text: string };
    return (
      <section aria-label="Notes" className="dash-section">
        <h2>Notes</h2>
        {text ? (
          <p className="dash-note">{text}</p>
        ) : (
          <p>
            Empty note. Choose Arrange widgets, then Settings, to write one.
          </p>
        )}
      </section>
    );
  },
  shortcuts: (_, config) => {
    const { links } = config as { links: Shortcut[] };
    return (
      <section aria-label="Shortcuts" className="dash-section">
        <h2>Shortcuts</h2>
        {links.length ? (
          <ul className="dash-shortcuts">
            {links.map((link) => (
              <li key={link.to}>
                <Link to={link.to}>{link.label}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>No shortcuts yet. Choose Arrange widgets, then Settings.</p>
        )}
      </section>
    );
  },
};

/** Whether this build can show the type (the library offers only these). */
export const hasRenderer = (type: string) => type in renderers;

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
      {render(context, resolved.config)}
    </>
  );
}
