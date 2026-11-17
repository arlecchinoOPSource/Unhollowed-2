import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const metric = (samples: number, average: number | null) => ({
  samples,
  average,
});
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

// Engine-shaped fixtures. Rust tests cover the arithmetic; these cover how
// the page composes, links, and degrades.
const fixtures = {
  __workspace: {
    issues: {
      availability: "available",
      reason: null,
      data: {
        created: 4,
        completed: 2,
        due: 3,
        dueCompleted: 2,
        duePercent: 66.7,
        open: 7,
        overdue: 1,
      },
    },
    calendar: {
      availability: "available",
      reason: null,
      data: {
        events: 3,
        allDayEvents: 1,
        timedEvents: 2,
        scheduledMinutes: 120,
        workBlocks: 1,
        workBlockMinutes: 60,
        truncated: false,
      },
    },
    habits: {
      availability: "available",
      reason: null,
      data: {
        eligible: 7,
        completed: 3,
        percent: (3 * 100) / 7,
        practice: { current: 2, longest: 4 },
      },
    },
  },
  __habitStats: {
    today: "2026-11-17",
    from: "2026-10-19",
    to: "2026-11-17",
    through: "2026-11-17",
    summary: { eligible: 7, completed: 3, percent: (3 * 100) / 7 },
    habits: [
      {
        habitId: "h1",
        name: "Walk",
        archived: false,
        eligible: 7,
        completed: 3,
        percent: (3 * 100) / 7,
        streaks: { current: 2, longest: 3 },
      },
    ],
    days: [],
    weeks: [
      bucket("2026-11-09", "2026-11-15", 7, 3),
      bucket("2026-11-16", "2026-11-17", 0, 0),
    ],
    months: [],
    practice: { current: 2, longest: 4 },
  },
  __progress: {
    totals: {
      total: 9,
      open: 7,
      done: 2,
      canceled: 0,
      completionPercent: 22.2,
      overdue: 1,
      upcoming: 2,
      undatedOpen: 0,
    },
    projects: [],
    deadlines: [],
    trend: {
      granularity: "day",
      buckets: [],
      doneTotal: 2,
      withTime: 2,
      withoutTime: 0,
    },
  },
  __schedule: {
    totals: {
      events: 3,
      allDayEvents: 1,
      timedEvents: 2,
      workBlocks: 1,
      deadlines: 1,
      eventMinutes: 120,
      workBlockMinutes: 60,
      busyMinutes: 150,
      overlapMinutes: 30,
    },
  },
};

const checkins = (recorded: number) => ({
  without: {
    from: "2026-10-19",
    to: "2026-11-17",
    through: "2026-11-17",
    daysInPeriod: 30,
    daysRecorded: recorded,
    mood: metric(recorded, recorded ? 3.5 : null),
    energy: metric(0, null),
    focus: metric(recorded, recorded ? 4 : null),
    points: [],
    weeks: [],
    months: [],
    habits: null,
  },
});

async function open(page: Page, recorded = 3) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript(
    ([data, mood]) => Object.assign(window, data, { __checkinAnalytics: mood }),
    [fixtures, checkins(recorded)] as const,
  );
  await page.goto("/dashboards");
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
}

const section = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("cards show the engine's values, each linked to its source", async ({
  page,
}) => {
  await open(page);
  const glance = section(page, "At a glance");
  await expect(glance.locator("dl")).toContainText("Open issues7");
  await expect(glance.locator("dl")).toContainText("Completed in this period2");
  await expect(glance.locator("dl")).toContainText("Overdue1");
  await expect(glance.locator("dl")).toContainText("Habit completion43%");
  await expect(glance.locator("dl")).toContainText(
    "Scheduled this period3 events, 3 h",
  );
  const href = (name: string | RegExp) =>
    glance.getByRole("link", { name }).getAttribute("href");
  expect(await href("7")).toBe("/issues");
  expect(await href("2")).toBe("/issues?state=closed&status=done");
  expect(await href("1")).toBe("/issues?due=overdue");
  expect(await href("43%")).toBe("/habits");
  expect(await href(/3 events/)).toBe("/calendar?view=month&date=2026-11-17");
  // Sections link to their sources too.
  for (const [name, link, to] of [
    ["Habits", "Open habits", "/habits"],
    ["Schedule", "Open calendar", "/calendar?view=month&date=2026-11-17"],
    ["Mood, energy, and focus", "Open check-ins", "/mood"],
  ] as const)
    await expect(
      section(page, name).getByRole("link", { name: link }),
    ).toHaveAttribute("href", to);
});

test("one period drives every section", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Last 7 days" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const args = (
          window as unknown as {
            __lastArgs: Record<string, { from: string; to: string }>;
          }
        ).__lastArgs;
        return [
          "get_workspace_analytics",
          "get_progress_analytics",
          "get_schedule_analytics",
          "get_habit_statistics",
          "get_checkin_analytics",
        ].map((command) => `${args[command]?.from}..${args[command]?.to}`);
      }),
    )
    .toEqual(Array(5).fill("2026-11-11..2026-11-17"));
});

test("a project filter leaves out what has no project, and says so", async ({
  page,
}) => {
  await open(page);
  const before = await page.evaluate(
    () =>
      (window as unknown as { __calls: Record<string, number> }).__calls
        .get_habit_statistics,
  );
  await page
    .locator(".dash-controls select")
    .first()
    .selectOption({ label: "Studio launch" });
  const glance = section(page, "At a glance");
  await expect(glance.locator("dl")).toContainText(
    "Habit completionNot part of a project",
  );
  await expect(section(page, "Habits")).toContainText(
    "Habits are not part of a project",
  );
  await expect(section(page, "Mood, energy, and focus")).toHaveCount(0);
  // The habit engine was not asked for numbers it would show unfiltered.
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __calls: Record<string, number> }).__calls
          .get_habit_statistics,
    ),
  ).toBe(before);
  expect(
    await glance.getByRole("link", { name: "7" }).getAttribute("href"),
  ).toBe("/issues?project=project-1");
});

test("mood appears only when the period has check-ins", async ({ page }) => {
  await open(page, 0);
  await expect(section(page, "Habits")).toBeVisible();
  await expect(section(page, "Mood, energy, and focus")).toHaveCount(0);
  await open(page, 3);
  const mood = section(page, "Mood, energy, and focus");
  await expect(mood).toContainText("3 of 30 days have a check-in");
  await expect(mood.locator("dl")).toContainText("Mood3.5 of 5 (3 days)");
  await expect(mood.locator("dl")).toContainText("EnergyNo ratings");
  await expect(mood.locator("dl")).toContainText("Focus4.0 of 5 (3 days)");
});

test("a failing section does not take the others down", async ({ page }) => {
  await open(page);
  await dispatch(page, "fail-command", "get_habit_statistics");
  await page.getByRole("button", { name: "Last 7 days" }).click();
  const habits = section(page, "Habits");
  await expect(habits.getByRole("alert")).toContainText("Could not save");
  await expect(habits.locator("dl")).toHaveCount(0);
  // The rest still answered for the new period.
  await expect(section(page, "At a glance").locator("dl")).toContainText(
    "Open issues7",
  );
  await expect(section(page, "Schedule").locator("dl")).toContainText(
    "Events3",
  );
  await dispatch(page, "restore-command", "get_habit_statistics");
  await habits.getByRole("button", { name: "Retry" }).click();
  await expect(habits.locator("dl")).toContainText("Completion rate43%");
});

test("narrow screens reflow without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page);
  await expect(section(page, "Habits").locator("dl")).toBeVisible();
  // The shell's own toolbar is wider than 375px; the dashboard's content is
  // not: its sections and controls stay inside the page, and wide tables
  // scroll inside their section instead of widening the page.
  const overflow = await page.evaluate(() => {
    const edge = document
      .querySelector("main, #main")!
      .getBoundingClientRect().right;
    return [
      ...document.querySelectorAll(
        ".dash-view > *, .dash-section, .dash-controls > *",
      ),
    ].filter((element) => element.getBoundingClientRect().right > edge + 1)
      .length;
  });
  expect(overflow).toBe(0);
  await expect(
    section(page, "At a glance").locator("dl > div").first(),
  ).toBeInViewport();
});
