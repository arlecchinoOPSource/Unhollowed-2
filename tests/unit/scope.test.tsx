import { expect, test } from "vitest";
import { effectiveScope } from "../../src/features/dashboard/scope";

const today = "2026-11-18";
const global = { from: "2026-10-20", to: "2026-11-18" };
const none = { project: false, habit: false };

test("a widget follows the dashboard unless its config names a period", () => {
  const inherit = effectiveScope(
    "stat-card",
    undefined,
    global,
    today,
    none,
    "Last 30 days",
  );
  expect(inherit).toMatchObject({ period: global, own: false });
  expect(inherit.periodLabel).toBe("Last 30 days (30 days)");

  const own = effectiveScope(
    "stat-card",
    { period: { preset: "last7" } },
    global,
    today,
    none,
    "Last 30 days",
  );
  expect(own).toMatchObject({
    period: { from: "2026-11-12", to: "2026-11-18" },
    own: true,
  });
  expect(own.periodLabel).toBe("Last 7 days (7 days)");
});

test("custom periods and the month preset resolve like the dashboard's", () => {
  const custom = effectiveScope(
    "heatmap",
    {
      period: {
        preset: "custom",
        custom: { from: "2026-11-01", to: "2026-11-03" },
      },
    },
    global,
    today,
    none,
    "x",
  );
  expect(custom.period).toEqual({ from: "2026-11-01", to: "2026-11-03" });
  expect(custom.periodLabel).toContain("(3 days)");
  const month = effectiveScope(
    "heatmap",
    { period: { preset: "month" } },
    global,
    today,
    none,
    "x",
  );
  expect(month.period).toEqual({ from: "2026-11-01", to: "2026-11-30" });
});

test("an invalid override is ignored, never half-applied", () => {
  const scope = effectiveScope(
    "stat-card",
    { period: { preset: "custom" } },
    global,
    today,
    none,
    "Last 30 days",
  );
  expect(scope).toMatchObject({ period: global, own: false });
});

test("types that do not take a period ignore one", () => {
  const scope = effectiveScope(
    "notes",
    { period: { preset: "last7" } },
    global,
    today,
    none,
    "x",
  );
  expect(scope).toMatchObject({ period: global, own: false });
});

test("record filters apply only where the type supports them", () => {
  const filters = { project: true, habit: true };
  expect(
    effectiveScope("stat-card", undefined, global, today, filters, "x"),
  ).toMatchObject({
    project: "applies",
    habit: "unsupported",
  });
  expect(
    effectiveScope("heatmap", undefined, global, today, filters, "x"),
  ).toMatchObject({
    project: "unsupported",
    habit: "applies",
  });
  expect(
    effectiveScope("stat-card", undefined, global, today, none, "x"),
  ).toMatchObject({
    project: "unused",
    habit: "unused",
  });
});
