import { expect, test } from "vitest";
import { settle } from "../../src/features/dashboard/grid";
import { readLayout, withNewIds } from "../../src/features/dashboard/layout";
import {
  defaultTemplate,
  fromTemplate,
  templates,
} from "../../src/features/dashboard/templates";
import { hasRenderer } from "../../src/features/dashboard/WidgetHost";
import {
  layoutProblem,
  resolveWidget,
  sizeProblem,
} from "../../src/features/dashboard/widgets";

const today = "2026-11-18";

test("the four starter dashboards exist by name", () => {
  expect(templates.map((t) => t.name)).toEqual([
    "General Productivity",
    "Student Workspace",
    "Project Management",
    "Personal Development",
  ]);
  expect(defaultTemplate.id).toBe("general");
});

test.each(templates.map((t) => [t.name, t] as const))(
  "%s makes a valid layout of widgets this build can show",
  (_, template) => {
    const layout = fromTemplate(template, today);
    expect(layout.widgets.length).toBeGreaterThan(0);
    expect(layoutProblem(layout.widgets)).toBeNull();
    for (const widget of layout.widgets) {
      expect(hasRenderer(widget.type)).toBe(true);
      expect(sizeProblem(widget.type, widget)).toBeNull();
      expect(
        resolveWidget({
          ...widget,
          config: widget.config ?? undefined,
        }).status,
      ).toBe("ready");
    }
    // Already settled: no overlaps and nothing to move.
    expect(settle(layout.widgets)).toEqual(layout.widgets);
    // It survives the same read a stored layout gets, unchanged.
    const read = readLayout(layout, 1, today);
    expect(read.recovery).toBe("ok");
    expect(read.layout).toEqual(layout);
  },
);

test("each use of a template gets its own IDs and shares nothing", () => {
  const a = fromTemplate(templates[1], today);
  const b = fromTemplate(templates[1], today);
  expect(a).toEqual(b);
  a.widgets[0].hidden = true;
  expect(b.widgets[0].hidden).toBe(false);
});

test("copying a dashboard allocates new instance IDs per type", () => {
  const widgets = [
    ...fromTemplate(templates[3], today).widgets,
    ...fromTemplate(templates[3], today).widgets.slice(0, 1),
  ];
  const copy = withNewIds(widgets);
  expect(new Set(copy.map((w) => w.id)).size).toBe(copy.length);
  expect(copy.map((w) => w.type)).toEqual(widgets.map((w) => w.type));
});

test("starter widgets share a row only where their widths fit", () => {
  const student = fromTemplate(templates[1], today).widgets;
  const sideBySide = student.filter((w) => w.w === 6);
  expect(sideBySide.length).toBeGreaterThanOrEqual(2);
  for (const w of student) expect(w.x + w.w).toBeLessThanOrEqual(12);
});
