import { beforeEach, expect, test } from "vitest";
import {
  defaultDashboard,
  layoutFromLegacy,
  ordered,
  readLayout,
} from "../../src/features/dashboard/layout";

const today = "2026-11-18";
beforeEach(() => localStorage.clear());

test("the default layout is the five Phase 4 sections, stacked and visible", () => {
  const layout = defaultDashboard(today);
  expect(layout.widgets.map((w) => w.id)).toEqual([
    "glance",
    "progress",
    "schedule",
    "habits",
    "mood",
  ]);
  expect(layout.widgets.every((w) => !w.hidden && w.w === 12)).toBe(true);
  const ys = layout.widgets.map((w) => w.y);
  expect(ys).toEqual([...ys].sort((a, b) => a - b));
  expect(layout.preferences.preset).toBe("last30");
});

test("legacy preferences carry over; unsupported values do not", () => {
  localStorage.setItem(
    "unhollowed-2-dashboard",
    JSON.stringify({
      version: 1,
      preset: "last7",
      custom: { from: "2026-11-01", to: "2026-11-10" },
      hidden: ["schedule", "nonsense", "mood"],
    }),
  );
  const layout = layoutFromLegacy(today);
  expect(layout.preferences.preset).toBe("last7");
  expect(layout.preferences.custom).toEqual({
    from: "2026-11-01",
    to: "2026-11-10",
  });
  expect(layout.widgets.filter((w) => w.hidden).map((w) => w.id)).toEqual([
    "schedule",
    "mood",
  ]);
  expect(layout.widgets).toHaveLength(5);
});

test("unreadable legacy preferences give the default layout", () => {
  localStorage.setItem("unhollowed-2-dashboard", "{nope");
  expect(layoutFromLegacy(today)).toEqual(defaultDashboard(today));
});

test("a valid stored layout reads back unchanged", () => {
  const stored = defaultDashboard(today);
  const reading = readLayout(stored, 1, today);
  expect(reading.recovery).toBe("ok");
  expect(reading.layout).toEqual(stored);
});

test("a newer version is shown as the default and flagged so it is not saved over", () => {
  const reading = readLayout({ version: 2, shiny: true }, 2, today);
  expect(reading.recovery).toBe("newer");
  expect(reading.layout).toEqual(defaultDashboard(today));
});

test("malformed records fall back to the default with a note", () => {
  for (const raw of [null, "x", 5, [], { version: 1 }, { version: 3 }]) {
    const reading = readLayout(raw, 1, today);
    expect(reading.recovery).toBe("malformed");
    expect(reading.layout).toEqual(defaultDashboard(today));
    expect(reading.notes.length).toBeGreaterThan(0);
  }
});

test("a readable layout is repaired field by field and keeps unknown widgets", () => {
  const raw = {
    version: 1,
    preferences: {
      preset: "last3650",
      custom: { from: "2026-02-30", to: "2026-03-01" },
    },
    widgets: [
      {
        id: "a",
        type: "notes",
        version: 1,
        config: { text: "hi" },
        hidden: false,
        x: 9,
        y: 0,
        w: 99,
        h: 3,
      },
      {
        id: "b",
        type: "from-the-future",
        version: 7,
        config: { z: 1 },
        hidden: true,
        x: 0,
        y: 3,
        w: 6,
        h: 2,
      },
      { id: "a", type: "notes", version: 1, x: 0, y: 0, w: 1, h: 1 },
      { id: "Bad Id", type: "notes" },
      { id: "c", type: "../x" },
      "junk",
    ],
  };
  const { layout, recovery, notes } = readLayout(raw, 1, today);
  expect(recovery).toBe("repaired");
  expect(layout.preferences.preset).toBe("last30");
  expect(layout.widgets.map((w) => w.id)).toEqual(["a", "b"]);
  // Clamped to the grid.
  expect(layout.widgets[0]).toMatchObject({
    x: 0,
    w: 12,
    config: { text: "hi" },
  });
  // The unknown widget survives untouched.
  expect(layout.widgets[1]).toMatchObject({
    type: "from-the-future",
    version: 7,
    hidden: true,
    config: { z: 1 },
  });
  expect(notes.join(" ")).toMatch(/dropped/);
});

test("widgets are read top to bottom, then left to right", () => {
  const base = defaultDashboard(today).widgets[0];
  const list = [
    { ...base, id: "c", y: 3, x: 0 },
    { ...base, id: "b", y: 0, x: 6 },
    { ...base, id: "a", y: 0, x: 0 },
  ];
  expect(ordered(list).map((w) => w.id)).toEqual(["a", "b", "c"]);
});
