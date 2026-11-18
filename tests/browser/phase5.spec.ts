import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

// The Phase 5 workflow through the UI, in both themes: Home, quick capture,
// a customized dashboard (widgets, settings, a widget's own period, arrange,
// starter dashboard, default), a restart, a drilldown to the counted issues,
// and links to records that are gone. The IPC is mocked, so it checks the UI
// and its requests, not persistence: that is `phase5_acceptance` (Rust).
test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const trend = {
  granularity: "day",
  buckets: [
    { start: "2026-11-09", end: "2026-11-09", completed: 3 },
    { start: "2026-11-10", end: "2026-11-10", completed: 0 },
    { start: "2026-11-11", end: "2026-11-11", completed: 2 },
  ],
  doneTotal: 5,
  withTime: 5,
  withoutTime: 0,
};

const menu = async (page: Page) => {
  const details = page.locator(".dash-manager details");
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
    await details.locator("summary").click();
};
const add = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: `Add ${name}` }).click();
};
const dashboard = (page: Page) =>
  page.getByRole("combobox", { name: "Dashboard", exact: true });

for (const scheme of ["light", "dark"] as const) {
  test(`Home, dashboards, restart, and drilldowns work together in ${scheme} mode`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: scheme });
    const outside: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!["127.0.0.1", "localhost", ""].includes(url.hostname))
        outside.push(request.url());
    });
    await installIpcMock(page);
    await page.addInitScript(
      (progressTrend) =>
        Object.assign(window, {
          __progress: { trend: progressTrend },
          __seedIssues: [
            { title: "Renew passport", dueDate: "2026-11-12" },
            { title: "Send invoice", dueDate: "2026-11-17", priority: "high" },
          ],
          __seedHabits: {
            today: "2026-11-17",
            habits: [{ name: "Walk", startDate: "2026-11-01" }],
          },
        }),
      trend,
    );
    await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));

    // Home: the day's work, with expected items.
    await page.goto("/");
    const region = (name: string) =>
      page.getByRole("region", { name, exact: true });
    await expect(region("Overdue")).toContainText("Renew passport");
    await expect(region("Due today")).toContainText("Send invoice");
    await expect(region("Habits today")).toContainText("0 of 1 done today.");
    await region("Habits today")
      .getByRole("button", { name: /^Mark done: Walk$/ })
      .click();
    await expect(region("Habits today")).toContainText("1 of 1 done today.");

    // Dashboards: add widgets, configure them, give one its own period.
    await page
      .getByRole("link", { name: "Dashboards", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "At a glance" }),
    ).toBeVisible();
    await menu(page);
    await page.getByRole("button", { name: "Arrange widgets" }).click();
    await add(page, "Notes");
    await add(page, "Bar chart");
    await add(page, "Comparison");
    await page.getByRole("button", { name: "Settings: Notes" }).click();
    await page
      .getByRole("dialog", { name: /Settings: Notes/ })
      .getByLabel("Note")
      .fill("Ship the beta");
    await page.getByRole("button", { name: "Apply" }).click();
    await page.getByRole("button", { name: "Settings: At a glance" }).click();
    await page
      .getByRole("dialog", { name: /Settings/ })
      .getByLabel("Period for this widget")
      .selectOption("last7");
    await page.getByRole("button", { name: "Apply" }).click();
    await page.getByRole("button", { name: "Move up: Notes" }).click();
    await page.getByRole("button", { name: "Save layout" }).click();
    await expect(page.locator('[data-scope="glance"]')).toContainText(
      "Last 7 days (7 days)",
    );

    // A starter dashboard, then make it the default.
    await menu(page);
    await page.getByRole("button", { name: "New dashboard" }).click();
    const create = page.getByRole("dialog", { name: "New dashboard" });
    await create.getByLabel("Name").fill("Study");
    await create.getByLabel(/Student Workspace/).check();
    await create.getByRole("button", { name: "Create" }).click();
    await expect(dashboard(page).locator("option:checked")).toHaveText("Study");
    await page.getByRole("button", { name: "Make default" }).click();

    // Restart: both dashboards, the default, and the first one's settings.
    await page.reload();
    await expect(dashboard(page).locator("option:checked")).toHaveText(
      "Study (default)",
    );
    await dashboard(page).selectOption({ label: "Dashboard" });
    await expect(page.locator('[data-cell="notes-1"]')).toContainText(
      "Ship the beta",
    );
    await expect(page.locator('[data-scope="glance"]')).toContainText(
      "Last 7 days",
    );
    await expect(page.locator('[data-cell="comparison-1"]')).toContainText(
      "not combined into a score",
    );

    // Inheritance: a project filter leaves out what has no project.
    await page
      .locator(".dash-controls select")
      .first()
      .selectOption({ label: "Studio launch" });
    await expect(
      page
        .locator('[data-cell="comparison-1"] [data-chart-state="unavailable"]')
        .first(),
    ).toContainText("not part of a project");
    await page.getByRole("button", { name: "Clear filters" }).click();

    // Drilldown: the chart's table lists expected values and opens the cohort.
    const chart = page.locator('[data-cell="bar-chart-1"]');
    await chart.getByText(/Show values/).click();
    const rows = chart.getByRole("row");
    await expect(rows.nth(1)).toContainText("3 issues");
    await expect(rows.nth(2)).toContainText("0 issues");
    await expect(rows.nth(3)).toContainText("2 issues");
    await chart.getByRole("link", { name: /^Open 3 issues completed/ }).click();
    await expect(page).toHaveURL(
      /completedFrom=2026-11-09&completedTo=2026-11-09/,
    );
    await page.getByRole("link", { name: "Back to the dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboards/);

    // Gone records explain themselves.
    await page.goto("/issues/missing-issue");
    await expect(
      page.getByRole("heading", { name: "Issue unavailable" }),
    ).toBeVisible();

    // Offline: nothing left this machine.
    expect(outside).toEqual([]);
  });
}
