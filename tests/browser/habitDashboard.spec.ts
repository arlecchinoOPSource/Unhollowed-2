import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const bucket = (
  start: string,
  end: string,
  eligible: number,
  completed: number,
) => ({
  start,
  end,
  eligible,
  completed,
  percent: eligible ? (completed * 100) / eligible : null,
});

// Engine-shaped output for 2026-11-15 to 2026-11-17 (see the Rust tests).
const stats = {
  today: "2026-11-17",
  from: "2026-10-19",
  to: "2026-11-17",
  through: "2026-11-17",
  summary: { eligible: 6, completed: 3, percent: 50 },
  habits: [
    {
      habitId: "habit-1",
      name: "Walk",
      archived: false,
      eligible: 3,
      completed: 3,
      percent: 100,
      streaks: { current: 3, longest: 3 },
    },
    {
      habitId: "habit-2",
      name: "Read",
      archived: true,
      eligible: 3,
      completed: 0,
      percent: 0,
      streaks: { current: 0, longest: 0 },
    },
    {
      habitId: "habit-3",
      name: "Later",
      archived: false,
      eligible: 0,
      completed: 0,
      percent: null,
      streaks: { current: 0, longest: 0 },
    },
  ],
  days: [
    bucket("2026-11-14", "2026-11-14", 0, 0),
    bucket("2026-11-15", "2026-11-15", 2, 1),
    bucket("2026-11-16", "2026-11-16", 2, 0),
    bucket("2026-11-17", "2026-11-17", 2, 2),
  ],
  weeks: [
    bucket("2026-11-09", "2026-11-15", 2, 1),
    bucket("2026-11-16", "2026-11-17", 4, 2),
  ],
  months: [bucket("2026-11-01", "2026-11-17", 6, 3)],
  practice: { current: 3, longest: 5 },
};

async function open(page: Page, value: object | null = stats) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((data) => {
    Object.assign(window, {
      __seedHabits: { today: "2026-11-17", habits: [{ name: "Walk" }] },
      ...(data ? { __habitStats: data } : {}),
    });
  }, value);
  await page.goto("/habits");
  await page.getByRole("button", { name: "Show trends" }).click();
  return page.getByRole("region", { name: "Habit trends" });
}

test("shows the engine's values, labeled, with table equivalents", async ({
  page,
}) => {
  const trends = await open(page);
  const tiles = trends.locator("dl");
  await expect(tiles).toContainText("Completion rate50%");
  await expect(tiles).toContainText("3 of 6 eligible");
  await expect(tiles).toContainText("Practice streak (any habit)");
  await expect(tiles).toContainText("3 days now, 5 days longest");

  await expect(
    trends.getByRole("img", { name: /^Daily completion rate/ }),
  ).toBeVisible();
  await expect(
    trends.getByRole("img", { name: /^Weekly completion/ }),
  ).toBeVisible();
  await trends.getByText("Data table: Weekly completion").click();
  const weekly = trends.getByRole("table", { name: "Weekly completion" });
  await expect(weekly.getByRole("row")).toHaveCount(3);
  await expect(weekly.getByRole("row").nth(2)).toContainText("50%");

  const each = trends.locator("table.habit-each");
  await expect(each.getByRole("row", { name: /^Walk/ })).toContainText(
    "3 of 3",
  );
  await expect(
    each.getByRole("row", { name: /^Read \(archived\)/ }),
  ).toContainText("0%");
  await expect(each.getByRole("row", { name: /^Later/ })).toContainText(
    "No eligible days",
  );
});

test("no data and zero are different shapes and words", async ({ page }) => {
  const trends = await open(page);
  // The first day had no eligible habit-days: a dashed slot, not a 0% point.
  await expect(trends.locator(".habit-missing-tick")).toHaveCount(1);
  await trends.getByText("Data table: Daily completion").click();
  const daily = trends.getByRole("table", { name: "Daily completion" });
  await expect(daily.getByRole("row").nth(1)).toContainText("No eligible days");
  await expect(daily.getByRole("row").nth(3)).toContainText("0%");
  await expect(trends.locator(".habit-dot")).toHaveCount(3);
});

test("a period with nothing eligible says so, and an empty workspace explains", async ({
  page,
}) => {
  const none = {
    ...stats,
    summary: { eligible: 0, completed: 0, percent: null },
    days: [bucket("2026-11-17", "2026-11-17", 0, 0)],
    weeks: [bucket("2026-11-16", "2026-11-17", 0, 0)],
    months: [bucket("2026-11-01", "2026-11-17", 0, 0)],
  };
  const trends = await open(page, none);
  await expect(trends.locator("dl")).toContainText("No eligible days");
  await expect(trends).toContainText("no rate yet");
  await expect(trends.locator(".habit-bar")).toHaveCount(0);
  await expect(trends.locator(".habit-missing")).toHaveCount(2);
});

test("no habits shows an empty state", async ({ page }) => {
  const trends = await open(page, null);
  await expect(trends).toContainText(
    "No habits yet. Add a habit to see trends.",
  );
});

test("a failed load shows an alert that can be retried", async ({ page }) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((data) => {
    Object.assign(window, {
      __seedHabits: { today: "2026-11-17", habits: [{ name: "Walk" }] },
      __habitStats: data,
    });
  }, stats);
  await page.goto("/habits");
  await dispatch(page, "fail-command", "get_habit_statistics");
  await page.getByRole("button", { name: "Show trends" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Could not save" });
  await expect(alert).toBeVisible();
  await dispatch(page, "restore-command", "get_habit_statistics");
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("term").filter({ hasText: "Completion rate" }),
  ).toBeVisible();
});

test("the range controls reload and the toggle hides the trends", async ({
  page,
}) => {
  const trends = await open(page);
  await trends.getByRole("button", { name: "Last 7 days" }).click();
  await expect(trends.getByLabel("From")).toHaveValue("2026-11-11");
  await expect(trends.getByLabel("To")).toHaveValue("2026-11-17");
  const toggle = page.getByRole("button", { name: "Hide trends" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(trends).toHaveCount(0);
});

const calls = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __calls?: Record<string, number> }).__calls?.[
        name
      ] ?? 0,
    command,
  );

test("a successful habit write refreshes open trends; a failed one does not", async ({
  page,
}) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((data) => {
    Object.assign(window, {
      __seedHabits: {
        today: "2026-11-17",
        habits: [{ name: "Walk", startDate: "2026-11-01" }],
      },
      __habitStats: data,
    });
  }, stats);
  await page.goto("/habits");
  await page.getByRole("button", { name: "Show trends" }).click();
  await expect(
    page.getByRole("term").filter({ hasText: "Completion rate" }),
  ).toBeVisible();
  const loaded = await calls(page, "get_habit_statistics");

  const cell = page.getByRole("button", {
    name: "Walk, Monday, November 16, 2026",
    exact: true,
  });
  await dispatch(page, "fail-once", "set_habit_completion");
  await cell.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Could not save" }),
  ).toBeVisible();
  // The write failed, so nothing changed and nothing was re-read.
  expect(await calls(page, "get_habit_statistics")).toBe(loaded);

  await page.getByRole("button", { name: "Retry" }).first().click();
  await expect
    .poll(() => calls(page, "get_habit_statistics"))
    .toBeGreaterThan(loaded);
});
