import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const calls = (page: Page) =>
  page.evaluate(() => ({
    ...(window as unknown as { __calls?: Record<string, number> }).__calls,
  }));

async function menu(page: Page) {
  const details = page.locator(".dash-manager details");
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
    await details.locator("summary").click();
}

/** A dashboard with five widgets that all read the same few sources. */
async function withManyWidgets(page: Page) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.goto("/dashboards");
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
  await menu(page);
  await page.getByRole("button", { name: "Arrange widgets" }).click();
  for (const name of ["Line chart", "Bar chart", "Comparison", "Insights"]) {
    await page.getByRole("button", { name: "Add widget" }).click();
    await page.getByRole("button", { name: `Add ${name}` }).click();
  }
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("button", { name: "Add widget" })).toHaveCount(0);
}

test("widgets that ask the same question share one request per scope", async ({
  page,
}) => {
  await withManyWidgets(page);
  // A fresh visit, so only this load's requests are counted. In-app
  // navigation keeps the in-memory backend and the saved layout.
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  // Let Home finish its own reads before counting.
  await expect(
    page.getByRole("region", { name: "Upcoming milestones", exact: true }),
  ).toContainText("Nothing due in the next two weeks");
  await expect(
    page.getByRole("region", { name: "Active projects", exact: true }),
  ).toContainText("Studio launch");
  await page.evaluate(() => {
    (window as unknown as { __calls: Record<string, number> }).__calls = {};
  });
  await page
    .getByRole("link", { name: "Dashboards", exact: true })
    .first()
    .click();
  await expect(
    page.locator('[data-cell="insights-1"]').getByRole("list"),
  ).toBeVisible();
  const sent = await calls(page);
  // Nine widgets read these sources. Without sharing, each would send its own:
  // progress is read by the issues section, two charts, the comparison, and
  // the insights (5); schedule by its section, the comparison, and the bar
  // chart's sibling (3) plus tomorrow's; and so on.
  expect(sent.get_progress_analytics).toBe(1);
  expect(sent.get_workspace_analytics).toBe(1);
  expect(sent.get_habit_statistics).toBe(1);
  expect(sent.get_checkin_analytics).toBe(1);
  // The schedule is read for the period and, for the insights, for tomorrow.
  expect(sent.get_schedule_analytics).toBe(2);
});

test("a write refreshes only the widgets that read what it changed", async ({
  page,
}) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript(() =>
    Object.assign(window, {
      __seedHabits: {
        today: "2026-11-17",
        habits: [{ name: "Walk", startDate: "2026-11-01" }],
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Habits today", exact: true }),
  ).toContainText("0 of 1 done today.");
  const before = await calls(page);
  await page.getByRole("button", { name: /^(Mark done|Undo): Walk$/ }).click();
  await expect(
    page.getByRole("region", { name: "Habits today", exact: true }),
  ).toContainText("1 of 1 done today.");
  const after = await calls(page);
  // The habit section read again once; the issue and milestone sections did not.
  expect(after.get_habit_month - before.get_habit_month).toBe(1);
  expect(after.get_progress_analytics).toBe(before.get_progress_analytics);
  expect(after.query_issues).toBe(before.query_issues);
  expect(after.list_projects).toBe(before.list_projects);
});

test("rapid period changes leave the dashboard on the last choice, with no error", async ({
  page,
}) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.goto("/dashboards");
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
  // The first request for the new period is held while a newer one finishes.
  await dispatch(page, "hold-command", "get_progress_analytics");
  await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
  await page.getByRole("button", { name: "This month", exact: true }).click();
  await expect(page.locator(".dash-period")).toContainText("Nov 1 – ");
  await dispatch(page, "release-get_progress_analytics", undefined);
  await expect(
    page.getByRole("region", { name: "Projects and issues" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const last = await page.evaluate(
    () =>
      (
        window as unknown as {
          __lastArgs: { get_progress_analytics: { from: string; to: string } };
        }
      ).__lastArgs.get_progress_analytics,
  );
  // The request most recently sent is for the month the page shows.
  expect(last.from).toBe("2026-11-01");
});

const stored = (widgets: unknown[]) => ({
  id: "dashboard-1",
  name: "Dashboard",
  position: 0,
  layoutVersion: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  layout: {
    version: 1,
    preferences: {
      preset: "last30",
      custom: { from: "2026-10-20", to: "2026-11-17" },
    },
    widgets,
  },
});

test("a malformed layout recovers what it can, keeps the rest, and loses nothing", async ({
  page,
}) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  const widget = (over: object) => ({
    version: 1,
    config: null,
    hidden: false,
    x: 0,
    y: 0,
    w: 12,
    h: 3,
    ...over,
  });
  await page.addInitScript(
    (record) => {
      if (!sessionStorage.getItem("__dashboards"))
        sessionStorage.setItem("__dashboards", JSON.stringify([record]));
    },
    stored([
      widget({ id: "glance", type: "stat-card", y: 0 }),
      widget({ id: "note-1", type: "notes", config: { text: 5 }, y: 3 }),
      widget({
        id: "future",
        type: "from-the-future",
        version: 7,
        config: { a: 1 },
        y: 6,
      }),
      widget({
        id: "chart",
        type: "line-chart",
        config: { metric: "nope" },
        y: 9,
      }),
      widget({
        id: "wide",
        type: "shortcuts",
        config: { links: [] },
        w: 99,
        y: 12,
      }),
      widget({ id: "Bad Id", type: "notes", y: 15 }),
    ]),
  );
  await page.goto("/dashboards");
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
  // The page says what it repaired; nothing is blank.
  await expect(
    page.getByRole("status").filter({ hasText: "dropped" }),
  ).toBeVisible();
  await expect(page.locator('[data-widget-notice="note-1"]')).toContainText(
    "not valid",
  );
  await expect(page.locator('[data-widget-notice="chart"]')).toBeVisible();
  await expect(page.locator('[data-cell="future"]')).toContainText(
    "not available in this version",
  );
  await expect(page.locator('[data-cell="wide"]')).toBeVisible();
  // Reading changed nothing that was stored.
  const untouched = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("__dashboards")!)[0].layout.widgets,
  );
  expect(untouched).toHaveLength(6);

  // The first change the user makes saves the repaired layout without losing
  // the widget this version does not know, or the settings it could not read.
  await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(sessionStorage.getItem("__dashboards")!)[0].layout
            .preferences.preset,
      ),
    )
    .toBe("last7");
  const saved = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("__dashboards")!)[0].layout.widgets,
  );
  const byId = Object.fromEntries(saved.map((w: { id: string }) => [w.id, w]));
  expect(byId.future).toMatchObject({
    type: "from-the-future",
    version: 7,
    config: { a: 1 },
  });
  expect(byId["note-1"].config).toEqual({ text: 5 });
  expect(byId.wide.w).toBe(12);
  expect(byId["Bad Id"]).toBeUndefined();
});

test("filters naming a record that no longer exists fall back safely", async ({
  page,
}) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.goto("/dashboards");
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
  // Filters are never stored, so a restart drops a project that was removed.
  await page.reload();
  await expect(page.locator(".dash-controls select").first()).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

// Render cost with many widgets: opt-in, because wall-clock numbers vary by
// machine. `PERF=1 npx playwright test dashboardPerformance --reporter=line`.
test("renders a dashboard of many widgets", async ({ page }) => {
  test.skip(!process.env.PERF, "Set PERF=1 to run the timing fixture.");
  test.setTimeout(120_000);
  await withManyWidgets(page);
  await page.addInitScript(() => {
    const long = window as unknown as { __long: number };
    long.__long = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) long.__long += entry.duration;
    }).observe({ type: "longtask", buffered: true });
  });
  const samples: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    await page.getByRole("link", { name: "Home", exact: true }).first().click();
    const start = Date.now();
    await page
      .getByRole("link", { name: "Dashboards", exact: true })
      .first()
      .click();
    await expect(
      page.locator('[data-cell="insights-1"]').getByRole("list"),
    ).toBeVisible();
    await expect(page.locator('[data-cell="comparison-1"]')).toContainText(
      "Data in",
    );
    samples.push(Date.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(
    `Dashboard with ${await page.locator("[data-cell]").count()} widgets: median ${samples[1]} ms to content`,
  );
});
