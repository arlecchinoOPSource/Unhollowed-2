import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { Chart } from "../../src/components/charts/Chart";

afterEach(cleanup);

const points = [
  { label: "1 Nov", value: 2 },
  { label: "2 Nov", value: null },
  { label: "3 Nov", value: 0 },
  { label: "4 Nov", value: 5 },
];
const props = {
  title: "Issues completed",
  range: "1 Nov to 4 Nov",
  format: (n: number) => `${n} issues`,
  series: [
    { name: "Completed", accent: "periwinkle" as const, points },
    { name: "Planned", accent: "amber" as const, points },
  ],
};

test.each(["bar", "line"] as const)(
  "%s chart: names its range, unit, and highest value, and lists every value",
  (kind) => {
    render(<Chart kind={kind} {...props} />);
    const image = screen.getByRole("img");
    expect(image).toHaveAccessibleName(/Issues completed, 1 Nov to 4 Nov/);
    expect(image).toHaveAccessibleName(/Highest value 5 issues/);
    // Legend names each series.
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getAllByRole("listitem")).toHaveLength(2);
    // The same values are readable without the picture or a pointer.
    const table = screen.getByRole("table", { hidden: true });
    const rows = within(table).getAllByRole("row", { hidden: true });
    expect(rows).toHaveLength(5);
    expect(rows[2]).toHaveTextContent("No data");
    expect(rows[3]).toHaveTextContent("0 issues");
    expect(rows[4]).toHaveTextContent("5 issues");
  },
);

test("missing data is not drawn as zero", () => {
  const { container } = render(<Chart kind="bar" {...props} />);
  const first = container.querySelector('[data-series="Completed"]')!;
  // 4 points, one missing: 3 bars with tooltips; the gap has none.
  expect(first.querySelectorAll("title")).toHaveLength(3);
  expect(first.textContent).not.toContain("2 Nov");
});

test("series differ by shape or pattern as well as color", () => {
  const { container } = render(<Chart kind="line" {...props} />);
  const a = container.querySelector('[data-series="Completed"] .chart-mark')!;
  const b = container.querySelector('[data-series="Planned"] .chart-mark')!;
  expect(a.firstElementChild!.tagName).not.toBe(b.firstElementChild!.tagName);
  const bars = render(<Chart kind="bar" {...props} />).container;
  expect(bars.querySelectorAll("pattern")).toHaveLength(1);
});

test("empty and unavailable look different and say why", () => {
  const empty = render(
    <Chart kind="line" {...props} state="empty" message="Nothing yet." />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Nothing yet.");
  expect(
    empty.container.querySelector("[data-chart-state=empty]"),
  ).toBeTruthy();
  cleanup();
  const gone = render(
    <Chart
      kind="line"
      {...props}
      state="unavailable"
      message="Does not apply."
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Does not apply.");
  expect(
    gone.container.querySelector("[data-chart-state=unavailable]"),
  ).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

test("a single point still draws", () => {
  render(
    <Chart
      kind="line"
      {...props}
      series={[
        { name: "One", accent: "green", points: [{ label: "x", value: 1 }] },
      ]}
    />,
  );
  expect(screen.getByRole("img")).toBeInTheDocument();
});

// WCAG non-text contrast: each series color against its theme's surface.
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("series colors have at least 3:1 contrast on the surface in both themes", () => {
  const charts = readFileSync("src/components/charts/charts.css", "utf8");
  const shell = readFileSync("src/styles/workspace.css", "utf8");
  const surface = (theme: "light" | "dark") =>
    theme === "light"
      ? /:root \{[^}]*--surface: (#\w+)/.exec(shell)![1]
      : /data-theme="dark"\] \{[^}]*--surface: (#\w+)/.exec(shell)![1];
  const block = (theme: "light" | "dark") =>
    theme === "light"
      ? /:root \{([^}]*)\}/.exec(charts)![1]
      : /data-theme="dark"\] \{([^}]*)\}/.exec(charts)![1];
  for (const theme of ["light", "dark"] as const) {
    const colors = [...block(theme).matchAll(/--series-(\w+): (#\w+)/g)];
    expect(colors.map((c) => c[1])).toEqual([
      "periwinkle",
      "green",
      "amber",
      "violet",
    ]);
    for (const [, name, hex] of colors)
      expect(
        contrast(hex, surface(theme)),
        `${theme} ${name}`,
      ).toBeGreaterThanOrEqual(3);
  }
});
