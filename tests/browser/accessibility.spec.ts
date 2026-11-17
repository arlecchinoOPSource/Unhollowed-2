import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Issue } from "../../src/database/issues";
import { installIpcMock } from "./ipcMock";

/** Every page, with seeded records so lists, badges, and charts render. */
const ROUTES = [
  "/",
  "/today",
  "/today/upcoming",
  "/calendar",
  "/calendar/calendars",
  "/documents",
  "/projects",
  "/projects/project-1",
  "/projects/project-1/goals",
  "/projects/project-1/issues",
  "/projects/project-1/board",
  "/issues",
  "/issues?state=all",
  "/issues/board",
  "/issues/labels",
  "/issues/milestones",
  "/issues/seed-1",
  "/graph",
  "/habits",
  "/mood",
  "/dashboards",
  "/settings",
];

const STATUSES = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "canceled",
] as const;
const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

function seed(page: Page) {
  const issues: Partial<Issue>[] = Array.from({ length: 24 }, (_, index) => ({
    title: `Audit issue ${index + 1}`,
    status: STATUSES[index % STATUSES.length],
    priority: PRIORITIES[index % PRIORITIES.length],
    projectId: index % 3 === 0 ? null : "project-1",
    dueDate: `2026-11-${String(10 + (index % 15)).padStart(2, "0")}`,
    archivedAt: index === 23 ? "2026-11-15T00:00:00Z" : null,
  }));
  return page.addInitScript((data) => {
    Object.assign(window, { __seedIssues: data });
  }, issues);
}

/**
 * Form fields whose border is under 3:1 against the background behind them
 * (WCAG 1.4.11). Axe does not check component boundaries.
 */
function faintFields(page: Page) {
  return page.evaluate(() => {
    const rgb = (value: string) =>
      (value.match(/[\d.]+/g) ?? []).map(Number) as number[];
    const luminance = ([r, g, b]: number[]) => {
      const [R, G, B] = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    const behind = (element: Element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const color = rgb(getComputedStyle(node).backgroundColor);
        if (color.length === 3 || color[3] > 0) return color;
      }
      return rgb(getComputedStyle(document.body).backgroundColor);
    };
    const problems: string[] = [];
    const fields = document.querySelectorAll<HTMLElement>(
      'input:not([type="checkbox"], [type="radio"], [type="file"], [type="hidden"]), select, textarea',
    );
    for (const field of fields) {
      if (!field.checkVisibility()) continue;
      // A borderless field may be framed by its container instead, as in
      // the search dialog, where the row's bottom edge marks the field.
      const framed = [field, field.parentElement!].map((element) => {
        const style = getComputedStyle(element);
        const side = parseFloat(style.borderTopWidth) > 0 ? "Top" : "Bottom";
        return parseFloat(style[`border${side}Width`]) > 0
          ? { element, color: style[`border${side}Color`] }
          : null;
      });
      const frame = framed[0] ?? framed[1];
      const name =
        field.getAttribute("aria-label") ??
        field.id ??
        field.getAttribute("name") ??
        field.tagName;
      if (!frame) {
        problems.push(`${name}: no border`);
        continue;
      }
      const [a, b] = [
        luminance(rgb(frame.color)),
        luminance(behind(frame.element)),
      ].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      if (ratio < 3) problems.push(`${name}: ${ratio.toFixed(2)}:1`);
    }
    return problems;
  });
}

test.beforeEach(async ({ page }) => {
  await installIpcMock(page);
  await seed(page);
  await page.clock.setFixedTime(new Date("2026-11-16T10:00:00"));
});

for (const scheme of ["light", "dark"] as const) {
  test(`every page passes automated WCAG AA checks in ${scheme} mode`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const found: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route);
      await expect(page.locator("h1").first(), route).toBeVisible();
      // Let data load so the scan sees the filled page, not a loading state.
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(150);
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      for (const problem of await faintFields(page))
        found.push(`${route} field border ${problem}`);
      for (const violation of violations)
        found.push(
          `${route} ${violation.id}: ${violation.help}\n${violation.nodes
            .slice(0, 4)
            .map(
              (node) =>
                `    ${node.target.join(" ")} ${node.failureSummary?.split("\n")[1] ?? ""}`,
            )
            .join("\n")}`,
        );
    }
    expect(found, found.join("\n")).toEqual([]);
  });
}

/** Scans the open page with the same rules as the route scan. */
async function scan(page: Page, label: string, found: string[]) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  for (const violation of violations)
    found.push(
      `${label} ${violation.id}: ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(" "))
        .join(", ")}`,
    );
  for (const problem of await faintFields(page))
    found.push(`${label} field border ${problem}`);
}

for (const scheme of ["light", "dark"] as const) {
  test(`dialogs, menus, and panels pass automated checks in ${scheme} mode`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ colorScheme: scheme });
    const found: string[] = [];

    // Workspace search with grouped results and an active option.
    await page.goto("/issues");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.getByRole("dialog", { name: "Search the workspace" });
    await search.getByRole("combobox").fill("audit");
    await expect(search.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await scan(page, "search dialog", found);
    await page.keyboard.press("Escape");

    // The board's Move menu.
    await page.goto("/issues/board");
    await page.getByRole("button", { name: /^Move ISS-1:/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await scan(page, "board move menu", found);
    await page.keyboard.press("Escape");

    // Relationship form, archived banner, and the deletion panel.
    await page.goto("/issues/seed-1");
    await page.getByRole("button", { name: "Add relationship" }).click();
    await scan(page, "relationship form", found);
    await page.getByRole("button", { name: "Archive issue" }).click();
    await page.getByRole("button", { name: "Delete permanently…" }).click();
    await expect(page.getByLabel("Type ISS-1 to confirm")).toBeFocused();
    await scan(page, "delete panel", found);

    // The project form and the keyboard shortcut help.
    await page.goto("/projects");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await scan(page, "project dialog", found);
    await page.keyboard.press("Escape");
    await page.goto("/issues");
    await page.getByText("Keyboard shortcuts").click();
    await scan(page, "shortcut help", found);

    // The event editor with its details open.
    await page.goto("/calendar");
    await page.getByRole("button", { name: "New event" }).click();
    const editor = page.getByRole("dialog", { name: "New event" });
    await editor.getByText("More details").click();
    await expect(editor.getByLabel("Time zone")).toBeVisible();
    await editor.getByLabel("Repeats").selectOption("monthly");
    await editor.getByLabel("Ends").selectOption("until");
    await scan(page, "event editor", found);
    await page.keyboard.press("Escape");

    expect(found, found.join("\n")).toEqual([]);
  });

  test(`every focusable control shows focus in ${scheme} mode`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme });
    const unmarked = new Set<string>();
    for (const route of [
      "/",
      "/today",
      "/issues",
      "/issues/board",
      "/issues/seed-1",
      "/projects/project-1",
      "/issues/milestones",
      "/settings",
    ]) {
      await page.goto(route);
      await expect(page.locator("h1").first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      // Tab through the page and check each stop has a visible indicator:
      // an outline, or a box shadow standing in for one.
      for (let stop = 0; stop < 60; stop += 1) {
        await page.keyboard.press("Tab");
        const result = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          if (!element || element === document.body) return null;
          const style = getComputedStyle(element);
          const visible =
            (style.outlineStyle !== "none" &&
              parseFloat(style.outlineWidth) >= 2) ||
            style.boxShadow !== "none";
          const name =
            element.getAttribute("aria-label") ??
            (element.id ||
              `${element.getAttribute("type") ?? ""} ${element.textContent?.trim().slice(0, 40) ?? ""}`);
          return visible ? "" : `${element.tagName} "${name}"`;
        });
        if (result === null) break;
        if (result) unmarked.add(`${route} ${result}`);
      }
    }
    expect([...unmarked], [...unmarked].join("\n")).toEqual([]);
  });
}

test("no page scrolls sideways at the smallest window width", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // tauri.conf.json sets the window's minimum width to 620.
  await page.setViewportSize({ width: 620, height: 600 });
  const wide: string[] = [];
  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator("h1").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    if (overflow > 0) wide.push(`${route} is ${overflow}px too wide`);
  }
  expect(wide, wide.join("\n")).toEqual([]);
});
