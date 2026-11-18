import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

async function open(page: Page, stored?: object | string) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript(
    ([value, seed]) => {
      // Set once, so a reload keeps whatever the page saved since.
      if (value !== undefined && !sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem(
          "unhollowed-2-dashboard",
          typeof value === "string" ? value : JSON.stringify(value),
        );
      }
      Object.assign(window, {
        __seedHabits: {
          today: "2026-11-17",
          habits: [
            { name: "Walk", startDate: "2026-11-01" },
            { name: "Read", startDate: "2026-11-01" },
          ],
        },
        ...(seed as object),
      });
    },
    [stored, {}] as const,
  );
  await page.goto("/dashboards");
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
}

const range = (page: Page, command: string) =>
  page.evaluate((name) => {
    const args = (
      window as unknown as {
        __lastArgs: Record<string, { from: string; to: string }>;
      }
    ).__lastArgs[name];
    return `${args.from}..${args.to}`;
  }, command);
const period = (page: Page) => page.locator(".dash-period");
const preset = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });

test("each preset resolves to the documented inclusive range", async ({
  page,
}) => {
  await open(page);
  await expect(preset(page, "Last 30 days")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(period(page)).toContainText("Oct 19 – Nov 17, 2026 (30 days)");
  expect(await range(page, "get_workspace_analytics")).toBe(
    "2026-10-19..2026-11-17",
  );

  await preset(page, "Last 7 days").click();
  await expect(period(page)).toContainText("Nov 11 – Nov 17, 2026 (7 days)");
  await expect
    .poll(() => range(page, "get_progress_analytics"))
    .toBe("2026-11-11..2026-11-17");
  expect(await range(page, "get_habit_statistics")).toBe(
    "2026-11-11..2026-11-17",
  );

  await preset(page, "This month").click();
  await expect(period(page)).toContainText("Nov 1 – Nov 30, 2026 (30 days)");
  await expect
    .poll(() => range(page, "get_schedule_analytics"))
    .toBe("2026-11-01..2026-11-30");
  // The same range reaches every section.
  expect(await range(page, "get_checkin_analytics")).toBe(
    "2026-11-01..2026-11-30",
  );
});

test("custom dates are inclusive, and a bad range explains itself and keeps a usable period", async ({
  page,
}) => {
  await open(page);
  await preset(page, "Custom dates").click();
  const custom = page.getByRole("group", { name: "Custom dates" });
  await custom.getByLabel("From").fill("2026-11-05");
  await custom.getByLabel("To").fill("2026-11-05");
  await expect(period(page)).toContainText("Nov 5, 2026 (1 day)");
  await expect
    .poll(() => range(page, "get_workspace_analytics"))
    .toBe("2026-11-05..2026-11-05");

  await custom.getByLabel("From").fill("2026-11-09");
  await expect(page.getByRole("alert")).toHaveText(
    "The start must be on or before the end. Showing the last 30 days until the dates are valid.",
  );
  await expect(period(page)).toContainText("(30 days)");
  await custom.getByLabel("To").fill("2026-11-12");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect
    .poll(() => range(page, "get_workspace_analytics"))
    .toBe("2026-11-09..2026-11-12");

  await custom.getByLabel("From").fill("2025-01-01");
  await expect(page.getByRole("alert")).toContainText(
    "Choose at most 366 days.",
  );
});

test("project and habit filters apply only where they make sense, and clearing restores the default", async ({
  page,
}) => {
  await open(page);
  await page
    .locator(".dash-controls select")
    .nth(1)
    .selectOption({ label: "Walk" });
  await expect(period(page)).toContainText("Habits filtered to one habit.");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __lastArgs: Record<string, { habitIds: string[] | null }>;
            }
          ).__lastArgs.get_habit_statistics.habitIds,
      ),
    )
    .toEqual(["habit-1"]);
  // The workspace-wide cards are unaffected by a habit filter.
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __lastArgs: Record<string, { projectId: string | null }>;
          }
        ).__lastArgs.get_workspace_analytics.projectId,
    ),
  ).toBeNull();

  // A project filter disables the habit filter, which has no meaning there.
  await page
    .locator(".dash-controls select")
    .first()
    .selectOption({ label: "Studio launch" });
  await expect(page.locator(".dash-controls select").nth(1)).toBeDisabled();
  await expect(page.locator(".dash-controls select").nth(1)).toHaveValue("");
  await expect(period(page)).toContainText("Filtered to one project.");

  await preset(page, "Last 7 days").click();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".dash-controls select").first()).toHaveValue("");
  await expect(page.locator(".dash-controls select").nth(1)).toBeEnabled();
  await expect(preset(page, "Last 30 days")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(
    0,
  );
  await expect(period(page)).not.toContainText("Filtered");
});

test("the period and visible sections survive a restart; the filters do not", async ({
  page,
}) => {
  await open(page);
  await preset(page, "Last 7 days").click();
  await page.getByText("Sections", { exact: true }).click();
  await page
    .getByRole("group", { name: "Visible sections" })
    .getByLabel("Schedule")
    .uncheck();
  await page
    .getByRole("group", { name: "Visible sections" })
    .getByLabel("Habits")
    .uncheck();
  await page
    .locator(".dash-controls select")
    .first()
    .selectOption({ label: "Studio launch" });
  await expect(
    page.getByRole("region", { name: "Schedule", exact: true }),
  ).toHaveCount(0);

  await page.reload();
  await expect(preset(page, "Last 7 days")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("region", { name: "Schedule", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Habits", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Projects and issues" }),
  ).toBeVisible();
  // The project filter named a record, so it starts fresh.
  await expect(page.locator(".dash-controls select").first()).toHaveValue("");

  await page.getByText("Sections", { exact: true }).click();
  await page.getByRole("button", { name: "Show all sections" }).click();
  await expect(
    page.getByRole("region", { name: "Schedule", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Show all sections" }),
  ).toHaveCount(0);
});

test("unusable stored preferences fall back to the defaults without an error", async ({
  page,
}) => {
  await open(page, {
    version: 1,
    preset: "last3650",
    custom: { from: "nope", to: "never" },
    hidden: ["nonsense", "mood"],
  });
  await expect(preset(page, "Last 30 days")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Projects and issues" }),
  ).toBeVisible();
});

test("every control works from the keyboard", async ({ page }) => {
  await open(page);
  await preset(page, "Last 30 days").focus();
  await page.keyboard.press("Tab");
  await expect(preset(page, "This month")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(preset(page, "This month")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await preset(page, "Last 7 days").focus();
  await page.keyboard.press("Space");
  await expect(period(page)).toContainText("(7 days)");
  await page.getByText("Sections", { exact: true }).focus();
  await page.keyboard.press("Enter");
  const mood = page
    .getByRole("group", { name: "Visible sections" })
    .getByLabel("Mood, energy, and focus");
  await mood.focus();
  await page.keyboard.press("Space");
  await expect(mood).not.toBeChecked();
});

test("a saved layout from a newer version is shown as the default and left unchanged", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const list = JSON.parse(sessionStorage.getItem("__dashboards")!);
    list[0].layoutVersion = 2;
    list[0].layout = { version: 2, shiny: true };
    sessionStorage.setItem("__dashboards", JSON.stringify(list));
  });
  await page.reload();
  await expect(page.getByRole("status").first()).toContainText("newer version");
  await preset(page, "Last 7 days").click();
  const stored = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("__dashboards")!)[0].layout,
  );
  expect(stored).toEqual({ version: 2, shiny: true });
});

test("a failed save keeps the change on screen and says so", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => Object.assign(window, { __failDashboards: true }));
  await preset(page, "Last 7 days").click();
  await expect(page.getByRole("alert")).toContainText("Could not read or save");
  await expect(preset(page, "Last 7 days")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("legacy browser preferences move into the saved dashboard once", async ({
  page,
}) => {
  await open(page, {
    version: 1,
    preset: "last7",
    custom: { from: "2026-11-01", to: "2026-11-10" },
    hidden: ["mood"],
  });
  await expect(preset(page, "Last 7 days")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const stored = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("__dashboards")!)[0].layout,
  );
  expect(stored.preferences.preset).toBe("last7");
  expect(
    stored.widgets.find((w: { id: string }) => w.id === "mood").hidden,
  ).toBe(true);
});

test("a widget can keep its own period; the others follow the dashboard; it can be reset", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator("[data-scope]")).toHaveCount(0);
  await page.getByText("Manage dashboards").click();
  await page.getByRole("button", { name: "Arrange widgets" }).click();
  await page.getByRole("button", { name: "Settings: At a glance" }).click();
  const dialog = page.getByRole("dialog", { name: /Settings/ });
  await dialog.getByLabel("Period for this widget").selectOption("last7");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("button", { name: "Save layout" }).click();

  const scope = page.locator('[data-scope="glance"]');
  await expect(scope).toContainText("Last 7 days (7 days)");
  await expect(scope).toContainText("this widget's own period");
  expect(await range(page, "get_workspace_analytics")).toBe(
    "2026-11-11..2026-11-17",
  );
  // The other sections still use the dashboard's 30 days.
  expect(await range(page, "get_progress_analytics")).toBe(
    "2026-10-19..2026-11-17",
  );
  await expect(period(page)).toContainText("30 days");

  // It is a stored display choice: it survives a restart.
  await page.reload();
  await expect(page.locator('[data-scope="glance"]')).toContainText(
    "Last 7 days",
  );

  await page
    .getByRole("button", { name: "Use the dashboard period: At a glance" })
    .click();
  await expect(page.locator("[data-scope]")).toHaveCount(0);
  expect(await range(page, "get_workspace_analytics")).toBe(
    "2026-10-19..2026-11-17",
  );
});

test("a record filter says where it does not apply", async ({ page }) => {
  await open(page);
  await page
    .locator(".dash-controls select")
    .first()
    .selectOption({ label: "Studio launch" });
  await expect(page.locator('[data-scope="habits"]')).toContainText(
    "project filter does not apply",
  );
  await expect(page.locator('[data-scope="glance"]')).toHaveCount(0);
});
