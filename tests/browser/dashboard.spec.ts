import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const totals = (
  open: number,
  done: number,
  canceled: number,
  overdue: number,
) => ({
  total: open + done + canceled,
  open,
  done,
  canceled,
  completionPercent: done + open > 0 ? (done * 100) / (done + open) : null,
  overdue,
  upcoming: 0,
  undatedOpen: 0,
});

// Engine-shaped output; the Rust tests cover the arithmetic and the parity
// with the project overview.
const progress = {
  totals: totals(2, 2, 2, 1),
  projects: [
    {
      projectId: "project-1",
      name: "Studio launch",
      status: "active",
      issues: totals(2, 1, 1, 1),
      milestonesOpen: 1,
      milestonesClosed: 1,
      objectives: 1,
      objectiveLinked: 2,
      objectiveDone: 1,
    },
    {
      projectId: "project-2",
      name: "Garden",
      status: "active",
      issues: totals(0, 0, 0, 0),
      milestonesOpen: 0,
      milestonesClosed: 0,
      objectives: 0,
      objectiveLinked: 0,
      objectiveDone: 0,
    },
  ],
  deadlines: [
    {
      kind: "issue",
      id: "seed-1",
      number: 1,
      title: "Renew passport",
      projectId: "project-1",
      projectName: "Studio launch",
      dueDate: "2026-11-12",
      overdue: true,
    },
    {
      kind: "milestone",
      id: "m1",
      number: null,
      title: "Beta",
      projectId: "project-1",
      projectName: "Studio launch",
      dueDate: "2026-11-25",
      overdue: false,
    },
  ],
  trend: {
    granularity: "day",
    buckets: [
      { start: "2026-11-09", end: "2026-11-09", completed: 0 },
      { start: "2026-11-10", end: "2026-11-10", completed: 2 },
      { start: "2026-11-11", end: "2026-11-11", completed: 1 },
    ],
    doneTotal: 3,
    withTime: 2,
    withoutTime: 1,
  },
};

async function open(page: Page, value: object | null = progress) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((data) => {
    if (data) Object.assign(window, { __progress: data });
  }, value);
  await page.goto("/dashboards");
  return page.getByRole("region", { name: "Projects and issues" });
}

test("shows totals, per-project progress, deadlines and the trend with their sources", async ({
  page,
}) => {
  const section = await open(page);
  const tiles = section.locator("dl");
  await expect(tiles).toContainText("Open issues2 of 6");
  await expect(tiles).toContainText("Completed2");
  await expect(tiles).toContainText("Completion rate50%");
  await expect(section).toContainText(
    "canceled issues are neither done nor outstanding",
  );

  const table = section.getByRole("table", { name: "Progress by project" });
  const studio = table.getByRole("row", { name: /^Studio launch/ });
  await expect(studio).toContainText("33%");
  await expect(studio).toContainText("1 of 2");
  await expect(studio).toContainText("1 of 2");
  // A project with no issues says so instead of 0% or 100%.
  await expect(table.getByRole("row", { name: /^Garden/ })).toContainText(
    "No issues yet",
  );
  await expect(table.getByRole("row", { name: /^Garden/ })).toContainText(
    "No linked issues",
  );

  const deadlines = section.getByRole("list", { name: "Deadlines" });
  await expect(deadlines.getByRole("listitem")).toHaveText([
    /Thursday, November 12, 2026 \(overdue\): ISS-1 Renew passport, Studio launch/,
    /Wednesday, November 25, 2026: Milestone Beta, Studio launch/,
  ]);
  await expect(
    deadlines.getByRole("link", { name: /Renew passport/ }),
  ).toHaveAttribute("href", "/issues/seed-1");
});

test("each count links to the issue list with the matching project filter", async ({
  page,
}) => {
  const section = await open(page);
  const row = section.getByRole("row", { name: /^Studio launch/ });
  await expect(
    row.getByRole("link", { name: "Studio launch" }),
  ).toHaveAttribute("href", "/projects/project-1");
  await expect(row.getByRole("link").nth(1)).toHaveAttribute(
    "href",
    "/issues?project=project-1",
  );
  await expect(row.getByRole("link").nth(2)).toHaveAttribute(
    "href",
    "/issues?project=project-1&state=closed&status=done",
  );
  await expect(row.getByRole("link").nth(3)).toHaveAttribute(
    "href",
    "/issues?project=project-1&due=overdue",
  );
  // The workspace-level cards carry no project, and a filter adds it.
  await expect(
    section.getByRole("link", { name: "2", exact: true }).first(),
  ).toHaveAttribute("href", "/issues");
  await page
    .locator(".dash-controls select")
    .selectOption({ label: "Studio launch" });
  await expect(section.locator("dl").getByRole("link").first()).toHaveAttribute(
    "href",
    "/issues?project=project-1",
  );
  await row.getByRole("link").nth(3).click();
  await expect(page).toHaveURL(/\/issues\?project=project-1&due=overdue/);
});

test("the trend states its coverage and has a text equivalent", async ({
  page,
}) => {
  const section = await open(page);
  await expect(section.getByRole("note")).toHaveText(
    "1 completed issue of 3 have no stored completion time, so they are not in this chart.",
  );
  await expect(section).toContainText(
    "An issue that was reopened or canceled later is no longer counted",
  );
  const chart = section.getByRole("img", { name: /^Issues completed per day/ });
  await expect(chart).toBeVisible();
  // A day with nothing completed is a visible baseline, not a gap.
  await expect(chart.locator(".dash-zero")).toHaveCount(1);
  await expect(chart.locator(".dash-bar")).toHaveCount(2);
  await section.getByText("Data table: completed over time").click();
  const rows = section
    .getByRole("table", { name: "Issues completed per day" })
    .getByRole("row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(2)).toContainText("Tuesday, November 10, 2026");
  await expect(rows.nth(2)).toContainText("2");

  // Full coverage shows no note.
  const full = await open(page, {
    ...progress,
    trend: { ...progress.trend, withTime: 3, withoutTime: 0 },
  });
  await expect(full.getByRole("note")).toHaveCount(0);
});

test("an empty workspace explains itself", async ({ page }) => {
  const section = await open(page, null);
  await expect(section).toContainText("No issues or projects yet.");
  await expect(section.getByRole("img")).toHaveCount(0);
});

test("a failed load clears old numbers and can be retried", async ({
  page,
}) => {
  const section = await open(page);
  await expect(section.locator("dl")).toContainText("Completion rate50%");
  await dispatch(page, "fail-command", "get_progress_analytics");
  await page.getByRole("button", { name: "Last 90 days" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Could not read local data" });
  await expect(alert).toBeVisible();
  await expect(section.locator("dl")).toHaveCount(0);
  await dispatch(page, "restore-command", "get_progress_analytics");
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(section.locator("dl")).toContainText("Completion rate50%");
});
