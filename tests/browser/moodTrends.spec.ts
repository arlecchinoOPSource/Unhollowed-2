import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const none = { samples: 0, average: null };
const metric = (samples: number, average: number) => ({ samples, average });

// Engine-shaped output (see src-tauri/src/checkins/analytics_tests.rs):
// mood rated on 3 of 5 recorded days, energy on 3, focus on 3.
const base = {
  from: "2026-10-19",
  to: "2026-11-17",
  through: "2026-11-17",
  daysInPeriod: 30,
  daysRecorded: 5,
  mood: metric(3, 11 / 3),
  energy: metric(3, 11 / 3),
  focus: metric(3, 3),
  points: [
    { date: "2026-11-02", mood: 4, energy: 2, focus: null },
    { date: "2026-11-03", mood: 2, energy: null, focus: null },
    { date: "2026-11-05", mood: null, energy: 5, focus: 3 },
    { date: "2026-11-10", mood: null, energy: null, focus: 1 },
    { date: "2026-11-16", mood: 5, energy: 4, focus: 5 },
  ],
  weeks: [
    {
      start: "2026-11-02",
      end: "2026-11-08",
      mood: metric(2, 3),
      energy: metric(2, 3.5),
      focus: metric(1, 3),
      habits: null as object | null,
    },
    {
      start: "2026-11-09",
      end: "2026-11-15",
      mood: none,
      energy: none,
      focus: metric(1, 1),
      habits: null as object | null,
    },
  ],
  months: [
    {
      start: "2026-11-01",
      end: "2026-11-17",
      mood: metric(3, 11 / 3),
      energy: metric(3, 11 / 3),
      focus: metric(3, 3),
      habits: null as object | null,
    },
  ],
  habits: null as object | null,
};
const withHabits = {
  ...base,
  weeks: [
    {
      ...base.weeks[0],
      habits: { eligible: 7, completed: 3, percent: (3 * 100) / 7 },
    },
    { ...base.weeks[1], habits: { eligible: 0, completed: 0, percent: null } },
  ],
  months: [
    {
      ...base.months[0],
      habits: { eligible: 17, completed: 3, percent: 17.6 },
    },
  ],
  habits: { eligible: 17, completed: 3, percent: 17.6 },
};

async function open(
  page: Page,
  analytics: object | null = { without: base, withHabits },
) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((value) => {
    Object.assign(window, value ? { __checkinAnalytics: value } : {});
  }, analytics);
  await page.goto("/mood");
  return page.getByRole("region", { name: "Trends" });
}

test("shows engine averages with their sample counts and keeps gaps as gaps", async ({
  page,
}) => {
  const trends = await open(page);
  const tiles = trends.locator("dl");
  await expect(tiles).toContainText("Mood3.7 of 5 (3 days)");
  await expect(tiles).toContainText("Focus3.0 of 5 (3 days)");
  await expect(trends).toContainText("5 days with a check-in out of 30");
  await expect(trends).toContainText("days without a rating are gaps");

  const mood = trends.getByRole("img", { name: /^Mood by day, scale 1 to 5/ });
  await expect(mood).toHaveAccessibleName(
    /3 days rated; days without a rating are gaps/,
  );
  // Marks exist only for rated days; Nov 2 and 3 are consecutive, so one line.
  await expect(mood.locator("circle")).toHaveCount(3);
  await expect(mood.locator("polyline")).toHaveCount(1);
  const energy = trends.getByRole("img", { name: /^Energy by day/ });
  await expect(energy.locator("circle")).toHaveCount(3);
  await expect(energy.locator("polyline")).toHaveCount(0);

  const weeks = trends.getByRole("table", { name: /^Weekly averages/ });
  await expect(weeks.getByRole("row").nth(1)).toContainText(
    "3.0 of 5 (2 days)",
  );
  await expect(weeks.getByRole("row").nth(1)).toContainText(
    "3.5 of 5 (2 days)",
  );
  // No rating that week is words, never 0.
  await expect(weeks.getByRole("row").nth(2)).toContainText("No ratings");
  await expect(weeks.getByRole("row").nth(2)).toContainText("1.0 of 5 (1 day)");
  await expect(
    weeks.getByRole("columnheader", { name: "Habit completion" }),
  ).toHaveCount(0);

  await trends.getByText("Data table: Mood by day").click();
  const table = trends.getByRole("table", { name: "Mood by day" });
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table).not.toContainText("November 5");
});

test("habit comparison is optional, aligned, and not causal", async ({
  page,
}) => {
  const trends = await open(page);
  await trends
    .getByLabel("Show habit completion beside weeks and months")
    .check();
  const weeks = trends.getByRole("table", { name: /^Weekly averages/ });
  await expect(
    weeks.getByRole("columnheader", { name: "Habit completion" }),
  ).toBeVisible();
  await expect(weeks.getByRole("row").nth(1)).toContainText("43% (3 of 7)");
  await expect(weeks.getByRole("row").nth(2)).toContainText("No eligible days");
  await expect(trends).toContainText(
    "does not show that one affects the other",
  );
  // The ratings are the same with the comparison on.
  await expect(trends.locator("dl")).toContainText("3.7 of 5 (3 days)");
});

test("period buttons reload, and an empty period explains itself", async ({
  page,
}) => {
  const empty = {
    ...base,
    daysRecorded: 0,
    points: [],
    mood: none,
    energy: none,
    focus: none,
    weeks: [],
    months: [],
  };
  const trends = await open(page, { without: empty, withHabits: empty });
  await expect(trends).toContainText("No check-ins between");
  await expect(trends.locator("svg")).toHaveCount(0);
  await trends.getByRole("button", { name: "Last 90 days" }).click();
  await expect(
    trends.getByRole("button", { name: "Last 90 days" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("a failed load can be retried", async ({ page }) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript(
    (value) => {
      Object.assign(window, { __checkinAnalytics: value });
    },
    { without: base, withHabits },
  );
  await page.goto("/mood");
  await dispatch(page, "fail-command", "get_checkin_analytics");
  await page.getByRole("button", { name: "Last 90 days" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Could not save" });
  await expect(alert).toBeVisible();
  await dispatch(page, "restore-command", "get_checkin_analytics");
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("term").filter({ hasText: "Mood" }),
  ).toBeVisible();
});
