import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Chart } from "../../src/components/charts/Chart";
import {
  completedIssues,
  habitDays,
  NOTES,
  scheduledTime,
} from "../../src/features/dashboard/drilldown";
import {
  hasFilters,
  readFilters,
  resetFilters,
  toQuery,
  toViewFilters,
  writeFilters,
} from "../../src/features/issues/filters";

afterEach(cleanup);

test("a completed-issues drilldown names the same days the metric counted", () => {
  const drill = completedIssues(
    { start: "2026-11-09", end: "2026-11-15" },
    4,
    "p1",
  );
  const url = new URL(drill.to, "http://app");
  expect(url.pathname).toBe("/issues");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    state: "closed",
    status: "done",
    completedFrom: "2026-11-09",
    completedTo: "2026-11-15",
    project: "p1",
  });
  expect(drill.text).toMatch(/^Open 4 issues completed/);
  expect(
    completedIssues({ start: "2026-11-09", end: "2026-11-09" }, 1, null).text,
  ).toMatch(/^Open 1 issue completed/);
});

test("calendar and habit drilldowns use the shared routes", () => {
  expect(scheduledTime({ start: "2026-11-09", end: "2026-11-09" }).to).toBe(
    "/calendar?view=day&date=2026-11-09",
  );
  expect(scheduledTime({ start: "2026-11-09", end: "2026-11-15" }).to).toBe(
    "/calendar?view=agenda&date=2026-11-09",
  );
  expect(habitDays({ start: "2026-11-09", end: "2026-11-15" }, "h1").to).toBe(
    "/habits?habit=h1&date=2026-11-09",
  );
  // A ratio across many habits has no single record: it opens the grid.
  expect(habitDays({ start: "2026-11-09", end: "2026-11-15" }, null).to).toBe(
    "/habits",
  );
  expect(NOTES.mood).toMatch(/not a list of records/);
});

test("the list reads, writes, and queries a completed range the same way", () => {
  const params = new URLSearchParams(
    "state=closed&status=done&completedFrom=2026-11-09&completedTo=2026-11-15",
  );
  const filters = readFilters(params);
  expect(filters).toMatchObject({
    completedFrom: "2026-11-09",
    completedTo: "2026-11-15",
  });
  expect(hasFilters(filters)).toBe(true);
  expect(writeFilters(filters).get("completedTo")).toBe("2026-11-15");
  const query = toQuery(filters, new Date(2026, 10, 17));
  // The instants are the local midnights bounding the days, so a completion
  // at any moment of those days matches.
  const from = new Date(query.completedFrom!);
  const before = new Date(query.completedBefore!);
  expect([from.getFullYear(), from.getMonth(), from.getDate()]).toEqual([
    2026, 10, 9,
  ]);
  expect([before.getFullYear(), before.getMonth(), before.getDate()]).toEqual([
    2026, 10, 16,
  ]);
  expect(from.getHours() + from.getMinutes()).toBe(0);
  expect(query.completedFrom).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // Clearing removes it; saved views never store it.
  expect(resetFilters(filters).completedFrom).toBe("");
  expect("completedFrom" in toViewFilters(filters)).toBe(false);
});

test("half a range, an impossible day, or a reversed range is ignored", () => {
  for (const query of [
    "completedFrom=2026-11-09",
    "completedTo=2026-11-09",
    "completedFrom=2026-02-30&completedTo=2026-03-01",
    "completedFrom=2026-11-15&completedTo=2026-11-09",
    "completedFrom=x&completedTo=y",
  ])
    expect(readFilters(new URLSearchParams(query)).completedFrom).toBe("");
});

const points = [
  { label: "9 Nov", value: 3 },
  { label: "10 Nov", value: 0 },
];

test("a chart's table links each point that has records, and a mark opens it too", () => {
  const onOpen = vi.fn();
  const { container } = render(
    <Chart
      kind="bar"
      title="Issues completed"
      range="r"
      format={(n) => `${n}`}
      series={[{ name: "Completed", accent: "periwinkle", points }]}
      drill={(_, i) =>
        i === 0 ? { to: "/issues?x=1", text: "Open 3 issues" } : null
      }
      onOpen={onOpen}
    />,
  );
  const link = screen.getByRole("link", {
    name: "Open 3 issues",
    hidden: true,
  });
  expect(link).toHaveAttribute("href", "/issues?x=1");
  // Activating the link navigates through the app, not the browser.
  fireEvent.click(link);
  expect(onOpen).toHaveBeenCalledWith("/issues?x=1");
  onOpen.mockClear();
  // Only the point with records is actionable.
  const marks = container.querySelectorAll(".chart-mark");
  expect(marks[0]).toHaveAttribute("data-drill");
  fireEvent.click(marks[0]);
  expect(onOpen).toHaveBeenCalledWith("/issues?x=1");
  expect(marks[1]).not.toHaveAttribute("data-drill");
  expect(screen.getAllByRole("link", { hidden: true })).toHaveLength(1);
});

test("aggregate-only charts explain why there is no list", () => {
  render(
    <Chart
      kind="line"
      title="Mood"
      range="r"
      format={(n) => `${n}`}
      series={[{ name: "Mood", accent: "amber", points }]}
      aggregateNote={NOTES.mood}
    />,
  );
  expect(screen.getByText(/not a list of records/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { hidden: true })).toBeNull();
});
