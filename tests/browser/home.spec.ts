import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

async function open(page: Page, seed: object = {}) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((data) => Object.assign(window, data), seed);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to Unhollowed." }),
  ).toBeVisible();
}

const section = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("Home shows today's work, each item linked to its source", async ({
  page,
}) => {
  await open(page, {
    __seedIssues: [
      { title: "Renew passport", dueDate: "2026-11-12" },
      { title: "Send invoice", dueDate: "2026-11-17", priority: "high" },
      { title: "Plan trip", dueDate: "2026-11-30" },
    ],
    __seedHabits: {
      today: "2026-11-17",
      habits: [
        { name: "Walk", startDate: "2026-11-01" },
        { name: "Read", startDate: "2026-11-01" },
      ],
    },
  });
  const overdue = section(page, "Overdue");
  await expect(overdue).toContainText("Renew passport");
  await expect(overdue).not.toContainText("Send invoice");
  await expect(
    overdue.getByRole("link", { name: "Open overdue issues" }),
  ).toHaveAttribute("href", "/issues?due=overdue");

  const today = section(page, "Due today");
  await expect(today).toContainText("Send invoice");
  await expect(today).not.toContainText("Plan trip");
  await expect(
    today.getByRole("link", { name: /Send invoice/ }),
  ).toHaveAttribute("href", /\/issues\/.+/);

  const habits = section(page, "Habits today");
  await expect(habits.getByRole("link", { name: "Walk" })).toHaveAttribute(
    "href",
    /\/habits\?habit=.+&date=2026-11-17/,
  );
  await expect(habits).toContainText("0 of 2 done today.");

  await expect(section(page, "Active projects")).toContainText("Studio launch");
});

test("every section explains an empty workspace", async ({ page }) => {
  await open(page);
  await expect(section(page, "Overdue")).toContainText("Nothing is overdue.");
  await expect(section(page, "Due today")).toContainText(
    "Nothing is due today.",
  );
  await expect(section(page, "Habits today")).toContainText(
    "No habits to do today.",
  );
  await expect(section(page, "Upcoming milestones")).toContainText(
    "No open milestones are due in the next two weeks.",
  );
  await expect(section(page, "Recent documents")).toContainText(
    "No documents yet.",
  );
});

test("a failing source takes down only its own section, which can be retried", async ({
  page,
}) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.goto("/issues");
  await dispatch(page, "fail-command", "list_projects");
  // Navigate inside the app so the failing mock stays installed.
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  const projects = section(page, "Active projects");
  await expect(projects.getByRole("alert")).toBeVisible();
  await expect(projects.getByRole("button", { name: "Retry" })).toBeVisible();
  // Others are fine.
  await expect(section(page, "Overdue")).toContainText("Nothing is overdue.");
  await expect(section(page, "Recent documents")).toBeVisible();
});

test("each list is bounded and points to the full list", async ({ page }) => {
  await open(page, {
    __seedIssues: Array.from({ length: 8 }, (_, i) => ({
      title: `Late ${i + 1}`,
      dueDate: "2026-11-10",
    })),
  });
  const overdue = section(page, "Overdue");
  await expect(overdue.getByRole("listitem")).toHaveCount(5);
  await expect(overdue.getByRole("link", { name: "3 more" })).toHaveAttribute(
    "href",
    "/issues?due=overdue",
  );
});

test("the summary follows the local date when the day changes", async ({
  page,
}) => {
  await installIpcMock(page);
  await page.clock.install({ time: new Date("2026-11-17T23:59:30+01:00") });
  await page.addInitScript(() =>
    Object.assign(window, {
      __seedIssues: [{ title: "Due the 18th", dueDate: "2026-11-18" }],
    }),
  );
  await page.goto("/");
  await expect(section(page, "Due today")).toContainText(
    "Nothing is due today.",
  );
  await page.clock.fastForward(60_000);
  await expect(section(page, "Due today")).toContainText("Due the 18th");
});

test("Home passes automated accessibility checks and keeps the area directory", async ({
  page,
}) => {
  await open(page);
  await page.getByText("All areas").click();
  await expect(
    page.getByRole("link", { name: /Calendar/ }).first(),
  ).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
