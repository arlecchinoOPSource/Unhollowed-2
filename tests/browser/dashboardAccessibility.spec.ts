import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const trend = {
  granularity: "day",
  buckets: [
    { start: "2026-11-09", end: "2026-11-09", completed: 3 },
    { start: "2026-11-10", end: "2026-11-10", completed: 0 },
    { start: "2026-11-11", end: "2026-11-11", completed: 2 },
    { start: "2026-11-12", end: "2026-11-12", completed: 1 },
  ],
  doneTotal: 6,
  withTime: 6,
  withoutTime: 0,
};

async function setup(page: Page, scheme: "light" | "dark") {
  await installIpcMock(page);
  await page.addInitScript((data) => Object.assign(window, data), {
    __progress: {
      totals: {
        total: 8,
        open: 2,
        done: 6,
        canceled: 0,
        completionPercent: 75,
        overdue: 1,
        upcoming: 1,
        undatedOpen: 0,
      },
      deadlines: [
        {
          kind: "milestone",
          id: "m1",
          number: null,
          title: "Beta",
          projectId: null,
          projectName: null,
          dueDate: "2026-11-25",
          overdue: false,
        },
      ],
      trend,
    },
    __seedIssues: [
      { title: "Renew passport", dueDate: "2026-11-12" },
      { title: "Draft the brief", status: "in_progress" },
    ],
    __seedDocuments: ["Venue notes"],
    __seedHabits: {
      today: "2026-11-17",
      habits: [{ name: "Walk", startDate: "2026-11-01" }],
    },
  });
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
}

/** The page really is in the scheme under test, with charts drawn. */
async function expectTheme(page: Page, scheme: "light" | "dark") {
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    scheme === "dark" ? "rgb(33, 33, 33)" : "rgb(247, 247, 247)",
  );
  await expect(page.locator("[data-chart]").first()).toBeVisible();
}

async function menu(page: Page) {
  const details = page.locator(".dash-manager details");
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
    await details.locator("summary").click();
}

/** Adds one of every widget the library offers that the dashboard lacks. */
async function addEverything(page: Page) {
  await menu(page);
  await page.getByRole("button", { name: "Arrange widgets" }).click();
  for (const name of [
    "Line chart",
    "Bar chart",
    "Comparison",
    "Insights",
    "Notes",
    "Shortcuts",
  ]) {
    await page.getByRole("button", { name: "Add widget" }).click();
    await page.getByRole("button", { name: `Add ${name}` }).click();
  }
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("button", { name: "Add widget" })).toHaveCount(0);
}

const scan = async (page: Page, label: string) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return violations.map(
    (v) =>
      `${label} ${v.id}: ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join(", ")}`,
  );
};

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode`, () => {
    test("every widget, arrange mode, and every dashboard dialog pass automated checks", async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await setup(page, scheme);
      await page.goto("/dashboards");
      await expect(
        page.getByRole("heading", { name: "At a glance" }),
      ).toBeVisible();
      await addEverything(page);
      await expectTheme(page, scheme);
      for (const cell of ["line-chart-1", "comparison-1", "insights-1"])
        await expect(page.locator(`[data-cell="${cell}"]`)).toBeVisible();
      // Open every chart's value table so its contents are scanned too.
      for (const summary of await page.locator(".chart-table summary").all())
        await summary.click();
      const found: string[] = await scan(page, "dashboard with every widget");

      await page.getByRole("button", { name: "Arrange widgets" }).click();
      found.push(...(await scan(page, "arrange mode")));
      await page.getByRole("button", { name: "Settings: Comparison" }).click();
      found.push(...(await scan(page, "widget settings")));
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Add widget" }).click();
      await page.getByRole("button", { name: "Preview Comparison" }).click();
      found.push(...(await scan(page, "widget library with a preview")));
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Cancel" }).click();

      await menu(page);
      for (const [button, dialog] of [
        ["New dashboard", "New dashboard"],
        ["Rename", "Rename dashboard"],
        ["Delete", "Delete dashboard?"],
        ["Reset layout", "Reset layout?"],
      ] as const) {
        await page.getByRole("button", { name: button, exact: true }).click();
        await expect(page.getByRole("dialog", { name: dialog })).toBeVisible();
        found.push(...(await scan(page, dialog)));
        await page.keyboard.press("Escape");
      }
      expect(found, found.join("\n")).toEqual([]);
    });

    test("every control on the dashboard shows focus, in view and arrange mode", async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await setup(page, scheme);
      await page.goto("/dashboards");
      await expect(
        page.getByRole("heading", { name: "At a glance" }),
      ).toBeVisible();
      await addEverything(page);
      for (const summary of await page.locator(".chart-table summary").all())
        await summary.click();
      const unmarked = new Set<string>();
      const walk = async (label: string) => {
        await page.locator("h1").first().focus();
        for (let stop = 0; stop < 400; stop += 1) {
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
              `${element.tagName} ${element.textContent?.trim().slice(0, 40) ?? ""}`;
            return visible ? "" : name;
          });
          if (result === null) break;
          if (result) unmarked.add(`${label}: ${result}`);
        }
      };
      await walk("view");
      await menu(page);
      await page.getByRole("button", { name: "Arrange widgets" }).click();
      await walk("arrange");
      expect([...unmarked], [...unmarked].join("\n")).toEqual([]);
    });

    test("with every widget, nothing scrolls sideways at 620 or 375 px", async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await setup(page, scheme);
      await page.goto("/dashboards");
      await expect(
        page.getByRole("heading", { name: "At a glance" }),
      ).toBeVisible();
      await addEverything(page);
      for (const summary of await page.locator(".chart-table summary").all())
        await summary.click();
      for (const width of [620, 375]) {
        await page.setViewportSize({ width, height: 800 });
        const overflow = await page.evaluate(() => {
          const edge = document
            .querySelector("main, #main")!
            .getBoundingClientRect().right;
          return [
            ...document.querySelectorAll(
              ".dash-view > *, .dash-cell, .dash-cell > *, .chart, .dash-toolbar",
            ),
          ].filter((el) => el.getBoundingClientRect().right > edge + 1).length;
        });
        expect(overflow, `${width}px`).toBe(0);
      }
    });
  });
}

test("dashboard content can be configured, placed, read, and opened with the keyboard alone", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await setup(page, "light");
  await page.goto("/dashboards");
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();

  const press = async (name: string | RegExp, key = "Enter") => {
    const control = page.getByRole("button", { name });
    await control.focus();
    await expect(control).toBeFocused();
    await page.keyboard.press(key);
  };

  // Open the manage menu and start arranging.
  await page.locator(".dash-manager summary").focus();
  await page.keyboard.press("Enter");
  await press("Arrange widgets");
  // Place and resize the habits widget with arrow keys.
  const frame = page.getByRole("group", { name: "Arrange Habits" });
  await frame.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".dash-arrange-note")).toContainText("Habits:");
  // Add a bar chart from the library and configure it.
  await press("Add widget");
  await press("Add Bar chart", "Space");
  await press("Settings: Bar chart", "Space");
  const dialog = page.getByRole("dialog", { name: /Settings: Bar chart/ });
  await dialog.getByLabel("Measure").selectOption("issues-completed");
  await press("Apply");
  await press("Save layout");
  await expect(page.getByRole("button", { name: "Add widget" })).toHaveCount(0);

  // Read the chart through its values table and open a point's records.
  const chart = page.locator('[data-cell="bar-chart-1"]');
  await chart.locator(".chart-table summary").focus();
  await page.keyboard.press("Enter");
  await expect(chart.getByRole("table")).toBeVisible();
  const link = chart
    .getByRole("link", { name: /^Open \d+ issues? completed/ })
    .first();
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/issues\?.*completedFrom=/);
  await page.getByRole("link", { name: "Back to the dashboard" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboards/);
});

test("loading, empty, and error states stay readable in both themes", async ({
  page,
}) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  const found: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Empty workspace: every section explains itself.
    await page.goto("/dashboards");
    await expect(
      page.getByRole("heading", { name: "At a glance" }),
    ).toBeVisible();
    found.push(...(await scan(page, `${scheme} empty`)));
    // A failing source: its section shows an alert with a retry.
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("fail-command", { detail: "get_progress_analytics" }),
      ),
    );
    await page.getByRole("link", { name: "Home", exact: true }).first().click();
    await page
      .getByRole("link", { name: "Dashboards", exact: true })
      .first()
      .click();
    await expect(
      page
        .getByRole("region", { name: "Projects and issues" })
        .getByRole("alert"),
    ).toBeVisible();
    found.push(...(await scan(page, `${scheme} error`)));
  }
  expect(found, found.join("\n")).toEqual([]);
});
