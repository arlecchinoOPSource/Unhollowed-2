import { expect, test } from "vitest";
import { defaultDashboard } from "../../src/features/dashboard/layout";
import {
  newWidget,
  newWidgetId,
} from "../../src/features/dashboard/WidgetLibrary";
import { hasRenderer } from "../../src/features/dashboard/WidgetHost";
import {
  ID_PATTERN,
  layoutProblem,
  resolveWidget,
  widgetDefinition,
  widgetTypes,
} from "../../src/features/dashboard/widgets";

const today = "2026-11-18";

test("new instance IDs are well formed and never collide", () => {
  const widgets = defaultDashboard(today).widgets;
  const first = newWidget(widgetDefinition("notes")!, widgets);
  const second = newWidget(widgetDefinition("notes")!, [...widgets, first]);
  expect([first.id, second.id]).toEqual(["notes-1", "notes-2"]);
  expect(ID_PATTERN.test(first.id)).toBe(true);
  expect(layoutProblem([...widgets, first, second])).toBeNull();
  expect(newWidgetId("x", [{ id: "x-1" }, { id: "x-2" }])).toBe("x-3");
});

test("a new widget starts below the others with its type's defaults", () => {
  const widgets = defaultDashboard(today).widgets;
  const bottom = Math.max(...widgets.map((w) => w.y + w.h));
  const added = newWidget(widgetDefinition("shortcuts")!, widgets);
  expect(added).toMatchObject({
    x: 0,
    y: bottom,
    config: { links: [] },
    hidden: false,
  });
  expect(resolveWidget(added).status).toBe("ready");
});

test("every field a type offers edits a key its own parse accepts", () => {
  for (const definition of widgetTypes) {
    for (const field of definition.fields ?? []) {
      // A period override is optional, so it is absent from the defaults.
      if (field.kind === "period") {
        expect(
          definition.parse({ [field.key]: { preset: "last7" } }),
        ).not.toBeNull();
      } else expect(Object.keys(definition.defaults)).toContain(field.key);
    }
    // Defaults are always valid, so Reset always yields something saveable.
    expect(definition.parse(definition.defaults)).not.toBeNull();
  }
});

test("the library offers only widgets this build can show", () => {
  expect(hasRenderer("notes")).toBe(true);
  expect(hasRenderer("heatmap")).toBe(true);
  expect(hasRenderer("line-chart")).toBe(true);
  expect(hasRenderer("issue-list")).toBe(false);
});
