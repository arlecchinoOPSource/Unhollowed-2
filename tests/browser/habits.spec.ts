import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

// Dates are local, so pin the zone, locale, and clock. The mock's "today"
// stands in for the backend's clock (docs/HABITS.md, fixture F3).
test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

test.beforeEach(async ({ page }) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript(() => {
    Object.assign(window, {
      __seedHabits: {
        today: "2026-11-17",
        habits: [
          { name: "Walk", startDate: "2026-11-05" },
          { name: "Read", startDate: "2026-11-01", archivedOn: "2026-11-12" },
          { name: "Later", startDate: "2026-12-01" },
        ],
        completions: [["habit-2", "2026-11-12"]],
      },
    });
  });
});

const cell = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });

test("one activation saves a check, and the month shows it when reopened", async ({
  page,
}) => {
  await page.goto("/habits");
  const today = cell(page, "Walk, Tuesday, November 17, 2026");
  await expect(today).toHaveAttribute("aria-pressed", "false");
  // Today's row is scrolled into view inside the grid on load.
  await expect(today).toBeInViewport();
  await today.click();
  await expect(today).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status")).toHaveText(
    "Saved: Walk, Tuesday, November 17, 2026, done.",
  );
  await expect(today).toBeFocused();

  await page.getByRole("button", { name: /^Next month/ }).click();
  await expect(
    page.getByRole("heading", { name: "December 2026" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Previous month/ }).click();
  await expect(cell(page, "Walk, Tuesday, November 17, 2026")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The mock backend holds it; Rust tests cover SQLite across restarts.
  const stored = await page.evaluate(() =>
    [
      ...(window as unknown as { __habits: { done: Set<string> } }).__habits
        .done,
    ].includes("habit-1|2026-11-17"),
  );
  expect(stored).toBe(true);
});

test("ineligible days cannot be edited and archived history stays visible", async ({
  page,
}) => {
  await page.goto("/habits");
  const grid = page.getByRole("grid", { name: "Habits, November 2026" });
  await expect(grid.getByRole("columnheader")).toHaveText([
    "Day",
    "Walk",
    "ReadArchived",
  ]);
  // The archive day is inclusive and keeps its check.
  const archiveDay = cell(page, "Read, Thursday, November 12, 2026");
  await expect(archiveDay).toHaveAttribute("aria-pressed", "true");
  await expect(archiveDay).not.toHaveAttribute("aria-disabled");

  for (const name of [
    "Read, Friday, November 13, 2026, not active on this day",
    "Walk, Wednesday, November 4, 2026, not active on this day",
    "Walk, Wednesday, November 18, 2026, future day",
  ]) {
    const locked = cell(page, name);
    await expect(locked).toHaveAttribute("aria-disabled", "true");
    // Playwright waits for aria-disabled controls to enable; a user's click does not.
    await locked.click({ force: true });
    await expect(locked).toHaveAttribute("aria-pressed", "false");
    // Unavailable days show a glyph, not only a color.
    await expect(locked).toHaveText("–");
  }
  await expect(page.getByRole("status")).toHaveText("");

  // An archived habit is a column only in months it was active.
  await page.keyboard.press("Alt+Shift+Period");
  await expect(
    page
      .getByRole("grid", { name: "Habits, December 2026" })
      .getByRole("columnheader"),
  ).toHaveText(["Day", "Walk", "Later"]);
  await page.keyboard.press("Alt+Shift+Comma");
  await page.keyboard.press("Alt+Shift+Comma");
  await expect(
    page.getByText("No habit was active in October 2026."),
  ).toBeVisible();
});

test("keyboard users move among cells, toggle, and hear the save state", async ({
  page,
}) => {
  await page.goto("/habits");
  await page.getByRole("button", { name: "Manage habits" }).focus();
  await page.keyboard.press("Tab");
  // One Tab stop, starting on today's row.
  const start = cell(page, "Walk, Tuesday, November 17, 2026");
  await expect(start).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  const fifteenth = cell(page, "Walk, Sunday, November 15, 2026");
  await expect(fifteenth).toBeFocused();
  await page.keyboard.press("Space");
  await expect(fifteenth).toHaveAttribute("aria-pressed", "true");
  await expect(fifteenth).toBeFocused();
  await expect(page.getByRole("status")).toHaveText(
    "Saved: Walk, Sunday, November 15, 2026, done.",
  );

  await page.keyboard.press("End");
  await expect(
    cell(page, "Read, Sunday, November 15, 2026, not active on this day"),
  ).toBeFocused();
  await page.keyboard.press("PageUp");
  await expect(cell(page, "Read, Sunday, November 8, 2026")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(cell(page, "Read, Sunday, November 8, 2026")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Control+Home");
  await expect(
    cell(page, "Walk, Sunday, November 1, 2026, not active on this day"),
  ).toBeFocused();
  await page.keyboard.press("Control+End");
  await expect(
    cell(page, "Read, Monday, November 30, 2026, future day"),
  ).toBeFocused();
  // Moving never leaves the grid; Tab does.
  await page.keyboard.press("ArrowDown");
  await expect(
    cell(page, "Read, Monday, November 30, 2026, future day"),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-cell]:focus")).toHaveCount(0);
});

test("a failed save keeps the cell, keeps focus, and can be retried", async ({
  page,
}) => {
  await page.goto("/habits");
  const today = cell(page, "Walk, Tuesday, November 17, 2026");
  await expect(today).toBeVisible();
  await dispatch(page, "fail-once", "set_habit_completion");
  await today.click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "Could not save Walk, Tuesday, November 17, 2026.",
  );
  await expect(today).toHaveAttribute("aria-pressed", "false");
  await expect(today).toBeFocused();

  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(alert).toHaveCount(0);
  await expect(today).toHaveAttribute("aria-pressed", "true");
  await expect(today).toBeFocused();
});

test("a second click during a save wins, so a slow save cannot overwrite it", async ({
  page,
}) => {
  await page.goto("/habits");
  const today = cell(page, "Walk, Tuesday, November 17, 2026");
  await expect(today).toBeVisible();
  await dispatch(page, "hold-command", "set_habit_completion");
  await today.click();
  await expect(
    cell(page, "Walk, Tuesday, November 17, 2026, saving"),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(
    cell(page, "Walk, Tuesday, November 17, 2026, saving"),
  ).toHaveAttribute("aria-pressed", "false");
  await dispatch(page, "release-set_habit_completion");
  await expect(page.getByRole("status")).toHaveText(
    "Saved: Walk, Tuesday, November 17, 2026, not done.",
  );
  await expect(today).toHaveAttribute("aria-pressed", "false");
  const stored = await page.evaluate(() =>
    [
      ...(window as unknown as { __habits: { done: Set<string> } }).__habits
        .done,
    ].includes("habit-1|2026-11-17"),
  );
  expect(stored).toBe(false);
});

test("month and year navigation, Today, and leap February", async ({
  page,
}) => {
  await page.goto("/habits");
  const todayButton = page.getByRole("button", { name: "Today" });
  await expect(todayButton).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("spinbutton", { name: "Year" }).fill("2028");
  await page.getByRole("combobox", { name: "Month" }).selectOption("2");
  await expect(
    page.getByRole("heading", { name: "February 2028" }),
  ).toBeVisible();
  await expect(todayButton).toHaveAttribute("aria-pressed", "false");
  const grid = page.getByRole("grid", { name: "Habits, February 2028" });
  await expect(grid.getByRole("row")).toHaveCount(30);
  await expect(
    cell(page, "Walk, Tuesday, February 29, 2028, future day"),
  ).toBeVisible();
  await page.keyboard.press("Alt+Shift+T");
  await expect(
    page.getByRole("heading", { name: "November 2026" }),
  ).toBeVisible();
  await expect(todayButton).toHaveAttribute("aria-pressed", "true");
});

test("adds a habit that starts today", async ({ page }) => {
  await page.goto("/habits");
  const form = page.getByRole("form", { name: "Add a habit" });
  await form.getByLabel("New habit").fill("walk");
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "An active habit already has this name. Choose a different name.",
  );
  await form.getByLabel("New habit").fill("Stretch");
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(cell(page, "Stretch, Tuesday, November 17, 2026")).toBeVisible();
  await expect(
    cell(page, "Stretch, Monday, November 16, 2026, not active on this day"),
  ).toBeVisible();
});
