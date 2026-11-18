import { expect, test } from "vitest";
import { sections } from "../../src/features/dashboard/controls";
import {
  defaultLayout,
  ID_PATTERN,
  layoutProblem,
  resolveWidget,
  sizeProblem,
  widgetDefinition,
  widgetTypes,
} from "../../src/features/dashboard/widgets";

test("every registered type is unique, versioned, and sized sanely", () => {
  const types = widgetTypes.map((item) => item.type);
  expect(new Set(types).size).toBe(types.length);
  expect(types).toEqual(
    expect.arrayContaining([
      "stat-card",
      "line-chart",
      "bar-chart",
      "heatmap",
      "issue-list",
      "agenda-list",
      "project-progress",
      "milestone-progress",
      "mood-trend",
      "notes",
      "shortcuts",
    ]),
  );
  for (const item of widgetTypes) {
    expect(item.version).toBe(1);
    expect(item.size.w).toBeLessThanOrEqual(12);
    expect(item.size.minW).toBeLessThanOrEqual(item.size.w);
    expect(item.size.minH).toBeLessThanOrEqual(item.size.h);
    expect(item.parse(item.defaults)).toEqual(item.defaults);
    expect(item.parse(undefined)).not.toBeNull();
  }
});

test("widgets that read data declare sources; static ones declare none", () => {
  expect(widgetDefinition("heatmap")?.sources).toEqual(["habits"]);
  expect(widgetDefinition("notes")?.sources).toEqual([]);
  expect(widgetDefinition("shortcuts")?.filters).toEqual([]);
});

test("the Phase 4 layout resolves and keeps the saved section keys", () => {
  expect(layoutProblem(defaultLayout)).toBeNull();
  expect(defaultLayout.map((item) => item.id)).toEqual(
    sections.map((item) => item.key),
  );
  for (const instance of defaultLayout)
    expect(resolveWidget(instance).status).toBe("ready");
});

test("an unknown type is a recoverable placeholder, never an error", () => {
  expect(
    resolveWidget({ id: "x", type: "from-the-future", version: 9 }),
  ).toEqual({ status: "unknown", type: "from-the-future" });
});

test("invalid or outdated config falls back to the defaults with a reason", () => {
  const bad = resolveWidget({
    id: "n",
    type: "notes",
    version: 1,
    config: { text: 5 },
  });
  expect(bad).toMatchObject({ status: "repaired", config: { text: "" } });
  const old = resolveWidget({ id: "n", type: "notes", version: 7 });
  expect(old.status).toBe("repaired");
  const extra = resolveWidget({
    id: "h",
    type: "heatmap",
    version: 1,
    config: { script: "alert(1)" },
  });
  expect(extra.status).toBe("repaired");
});

test("notes and shortcuts validate their config", () => {
  const notes = widgetDefinition("notes")!;
  expect(notes.parse({ text: "hi" })).toEqual({ text: "hi" });
  expect(notes.parse({ text: "x".repeat(2001) })).toBeNull();
  const shortcuts = widgetDefinition("shortcuts")!;
  const link = { label: "Habits", to: "/habits" };
  expect(shortcuts.parse({ links: [link] })).toEqual({ links: [link] });
  for (const to of ["https://example.com", "//evil.test", "javascript:1", ""])
    expect(shortcuts.parse({ links: [{ label: "x", to }] })).toBeNull();
  expect(shortcuts.parse({ links: [{ label: " ", to: "/a" }] })).toBeNull();
  expect(
    shortcuts.parse({ links: Array.from({ length: 13 }, () => link) }),
  ).toBeNull();
});

test("layouts need well-formed, unique IDs", () => {
  expect(ID_PATTERN.test("Bad Id")).toBe(false);
  expect(
    layoutProblem([
      { id: "a", type: "notes", version: 1 },
      { id: "a", type: "notes", version: 1 },
    ]),
  ).toMatch(/twice/);
  expect(layoutProblem([{ id: "A!", type: "notes", version: 1 }])).toMatch(
    /valid/,
  );
});

test("size limits come from the type", () => {
  expect(sizeProblem("heatmap", { w: 12, h: 4 })).toBeNull();
  expect(sizeProblem("heatmap", { w: 2, h: 4 })).not.toBeNull();
  expect(sizeProblem("heatmap", { w: 13, h: 4 })).not.toBeNull();
  expect(sizeProblem("heatmap", { w: 6.5, h: 4 })).not.toBeNull();
  expect(sizeProblem("nope", { w: 6, h: 4 })).toMatch(/Unknown/);
});

test("period overrides are validated like the dashboard's own period", async () => {
  const { parsePeriodConfig } =
    await import("../../src/features/dashboard/widgets");
  expect(parsePeriodConfig(undefined)).toEqual({});
  expect(parsePeriodConfig({})).toEqual({});
  expect(parsePeriodConfig({ period: { preset: "last7" } })).toEqual({
    period: { preset: "last7" },
  });
  const custom = { from: "2026-11-01", to: "2026-11-10" };
  expect(parsePeriodConfig({ period: { preset: "custom", custom } })).toEqual({
    period: { preset: "custom", custom },
  });
  for (const bad of [
    { period: { preset: "last3650" } },
    { period: { preset: "custom" } },
    { period: { preset: "last7", custom } },
    {
      period: {
        preset: "custom",
        custom: { from: "2026-11-10", to: "2026-11-01" },
      },
    },
    {
      period: {
        preset: "custom",
        custom: { from: "2026-02-30", to: "2026-03-01" },
      },
    },
    {
      period: {
        preset: "custom",
        custom: { from: "2020-01-01", to: "2026-11-01" },
      },
    },
    { period: { preset: "last7" }, extra: 1 },
    { period: "last7" },
    [],
  ])
    expect(parsePeriodConfig(bad)).toBeNull();
});
