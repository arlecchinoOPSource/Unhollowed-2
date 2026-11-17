import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const load = (over: object = {}) => ({
  events: 0,
  allDayEvents: 0,
  timedEvents: 0,
  workBlocks: 0,
  deadlines: 0,
  eventMinutes: 0,
  workBlockMinutes: 0,
  busyMinutes: 0,
  overlapMinutes: 0,
  ...over,
});

// Engine-shaped output; see src-tauri/src/analytics/schedule_tests.rs.
const schedule = {
  truncated: false,
  totals: load({
    events: 3,
    allDayEvents: 1,
    timedEvents: 2,
    workBlocks: 1,
    deadlines: 2,
    eventMinutes: 120,
    workBlockMinutes: 60,
    busyMinutes: 120,
    overlapMinutes: 60,
  }),
  days: [
    { start: "2026-11-09", end: "2026-11-09", ...load() },
    {
      start: "2026-11-10",
      end: "2026-11-10",
      ...load({
        timedEvents: 2,
        events: 2,
        workBlocks: 1,
        eventMinutes: 120,
        workBlockMinutes: 60,
        busyMinutes: 120,
        overlapMinutes: 60,
        deadlines: 1,
      }),
    },
  ],
  weeks: [],
  projects: [
    {
      kind: "project",
      projectId: "project-1",
      name: "Studio launch",
      events: 1,
      eventMinutes: 90,
      workBlocks: 1,
      workBlockMinutes: 60,
      deadlines: 1,
    },
    {
      kind: "shared",
      projectId: null,
      name: "Linked to several projects",
      events: 1,
      eventMinutes: 30,
      workBlocks: 0,
      workBlockMinutes: 0,
      deadlines: 0,
    },
    {
      kind: "unassigned",
      projectId: null,
      name: "No project",
      events: 1,
      eventMinutes: 0,
      workBlocks: 0,
      workBlockMinutes: 0,
      deadlines: 1,
    },
  ],
  upcoming: {
    events: 1,
    workBlocks: 1,
    deadlines: 1,
    next: [
      {
        kind: "event",
        id: "e1",
        title: "Planning",
        allDay: false,
        when: "2026-11-18T09:00",
      },
      {
        kind: "work_block",
        id: "w1",
        title: "Write spec",
        allDay: false,
        when: "2026-11-18T15:00",
      },
      {
        kind: "deadline",
        id: "i1",
        title: "Renew passport",
        allDay: true,
        when: "2026-11-19",
      },
    ],
  },
};

async function open(page: Page, value: object | null = schedule) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((data) => {
    if (data) Object.assign(window, { __schedule: data });
  }, value);
  await page.goto("/dashboards");
  return page.getByRole("region", { name: "Schedule", exact: true });
}

test("keeps events, planned work sessions, and due dates apart and labeled as scheduled", async ({
  page,
}) => {
  const section = await open(page);
  await expect(section).toContainText(
    "scheduled hours, what the calendar plans, not time actually spent",
  );
  const tiles = section.locator("dl");
  await expect(tiles).toContainText(
    "Events3 (2 timed, 1 all-day), 2 h scheduled",
  );
  await expect(tiles).toContainText("Planned work sessions1, 1 h scheduled");
  await expect(tiles).toContainText("Open due dates2");
  await expect(tiles).toContainText(
    "Busy time2 h, 1 h of overlap counted once",
  );

  const upcoming = section.getByRole("list", { name: "Coming up" });
  await expect(upcoming.getByRole("listitem")).toHaveText([
    "Event: Planning, Wednesday, November 18, 2026 09:00",
    "Planned work session: Write spec, Wednesday, November 18, 2026 15:00",
    "Due date: Renew passport, Thursday, November 19, 2026",
  ]);
  await expect(section).toContainText(
    "1 event, 1 planned work session, 1 due date.",
  );
});

test("project time separates assigned, shared, and unassigned work", async ({
  page,
}) => {
  const section = await open(page);
  const table = section.getByRole("table", {
    name: "Scheduled time by project",
  });
  await expect(
    table.getByRole("row", { name: /^Studio launch/ }),
  ).toContainText("1, 1 h 30 min");
  await expect(
    table.getByRole("row", { name: /^Linked to several projects/ }),
  ).toContainText("1, 30 min");
  await expect(table.getByRole("row", { name: /^No project/ })).toContainText(
    "1, 0 min",
  );
});

test("the chart has a label and a text equivalent, and quiet days stay visible", async ({
  page,
}) => {
  const section = await open(page);
  const chart = section.getByRole("img", { name: /^Scheduled time per day/ });
  await expect(chart).toHaveAccessibleName(/highest 2 h/);
  await expect(chart.locator(".dash-bar")).toHaveCount(1);
  await expect(chart.locator(".dash-zero")).toHaveCount(1);
  await section.getByText("Data table: scheduled time").click();
  const rows = section
    .getByRole("table", { name: "Scheduled time", exact: true })
    .getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText("Tuesday, November 10, 2026");
  await expect(rows.nth(2)).toContainText("2 h");
  await expect(rows.nth(1)).toContainText("0 min");
});

test("an empty period, a truncated calendar, and a failed load are each explained", async ({
  page,
}) => {
  const empty = await open(page, null);
  await expect(empty).toContainText("Nothing is scheduled in this period.");
  await expect(empty).toContainText(
    "Nothing scheduled or due in the next 7 days.",
  );

  const cut = await open(page, { ...schedule, truncated: true });
  await expect(cut.getByRole("note")).toContainText("counts may be low");

  const good = await open(page);
  await expect(good.locator("dl")).toContainText("Open due dates2");
  await dispatch(page, "fail-command", "get_schedule_analytics");
  await page.getByRole("button", { name: "Last 90 days" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Could not read local data" });
  await expect(alert).toBeVisible();
  await expect(good.locator("dl")).toHaveCount(0);
  await dispatch(page, "restore-command", "get_schedule_analytics");
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(good.locator("dl")).toContainText("Open due dates2");
});
