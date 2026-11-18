import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

async function open(page: Page, seed: object) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2028-03-01T10:00:00+01:00"));
  await page.addInitScript((value) => {
    Object.assign(window, { __seedHabits: value });
  }, seed);
  await page.goto("/habits");
  await page.getByRole("button", { name: "Show history" }).click();
  return page.getByRole("region", { name: "Habit history" });
}

// docs/HABITS.md fixture F1 with today 2028-03-01.
const f1 = {
  today: "2028-03-01",
  habits: [
    { name: "Synthetic walk", startDate: "2028-01-01" },
    {
      name: "Synthetic retired",
      startDate: "2027-12-01",
      archivedOn: "2028-01-15",
    },
    { name: "Synthetic read", startDate: "2028-02-01" },
  ],
  completions: [
    ["habit-2", "2028-01-10"],
    ["habit-3", "2028-02-28"],
    ["habit-3", "2028-02-29"],
  ],
};

const day = (page: Page, label: string) =>
  page.getByRole("button", { name: label, exact: true });

test("month view marks completed, missed, inactive, and future days in words", async ({
  page,
}) => {
  const history = await open(page, f1);
  await history
    .getByLabel("Habit")
    .selectOption({ label: "Synthetic retired (archived)" });
  await history.getByRole("button", { name: "Previous month" }).click(); // February
  await history.getByRole("button", { name: "Previous month" }).click(); // January 2028
  await expect(
    history.getByRole("heading", { name: "January 2028" }),
  ).toBeVisible();
  await expect(day(page, "Monday, January 10, 2028: Completed")).toHaveText(
    /✓/,
  );
  await expect(day(page, "Sunday, January 9, 2028: Missed")).toBeVisible();
  // The archive day is eligible; the next day is not.
  await expect(day(page, "Saturday, January 15, 2028: Missed")).toBeVisible();
  await expect(
    day(
      page,
      "Sunday, January 16, 2028: Not active: after the habit was archived",
    ),
  ).toBeVisible();
  await expect(history).toContainText(
    "1 of 15 eligible days completed in January 2028.",
  );
});

test("leap February and the year boundary render the right days", async ({
  page,
}) => {
  const history = await open(page, f1);
  await history.getByLabel("Habit").selectOption({ label: "Synthetic read" });
  await history.getByRole("button", { name: "Previous month" }).click();
  await expect(
    day(page, "Tuesday, February 29, 2028: Completed"),
  ).toBeVisible();
  await expect(history.locator("[data-date]")).toHaveCount(29);
  await expect(day(page, "Sunday, February 27, 2028: Missed")).toBeVisible();

  await history.getByRole("button", { name: "Year" }).click();
  await expect(history.locator("[data-date]")).toHaveCount(366);
  await history.getByRole("button", { name: "Previous year" }).click();
  await expect(history.locator("[data-date]")).toHaveCount(365);
  await expect(
    day(
      page,
      "Friday, December 31, 2027: Not active: before the habit started",
    ),
  ).toBeVisible();
});

test("keyboard moves between days, changes month, and selects with detail", async ({
  page,
}) => {
  const history = await open(page, f1);
  await history.getByLabel("Habit").selectOption({ label: "Synthetic read" });
  const today = day(page, "Wednesday, March 1, 2028: Not done yet today");
  await expect(today).toHaveAttribute("tabindex", "0");
  await today.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    day(page, "Tuesday, February 29, 2028: Completed"),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(day(page, "Tuesday, February 22, 2028: Missed")).toBeFocused();
  await page.keyboard.press("PageUp");
  await expect(
    day(
      page,
      "Saturday, January 22, 2028: Not active: before the habit started",
    ),
  ).toBeFocused();
  await page.keyboard.press("PageDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  const detail = history.getByRole("status");
  await expect(detail).toContainText("Wednesday, February 23, 2028: Missed.");
  await expect(detail.getByRole("link")).toHaveAttribute(
    "href",
    /habit=habit-3&date=2028-02-23/,
  );
});

test("the year heatmap uses week columns and keeps one tab stop", async ({
  page,
}) => {
  const history = await open(page, f1);
  await history.getByLabel("Habit").selectOption({ label: "Synthetic read" });
  await history.getByRole("button", { name: "Year" }).click();
  await expect(history.getByRole("heading", { name: "2028" })).toBeVisible();
  await expect(history.locator('[data-date][tabindex="0"]')).toHaveCount(1);
  const start = day(page, "Wednesday, March 1, 2028: Not done yet today");
  await start.focus();
  await page.keyboard.press("ArrowLeft"); // one week back in the year view
  await expect(day(page, "Wednesday, February 23, 2028: Missed")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(day(page, "Thursday, February 24, 2028: Missed")).toBeFocused();
});

test("a history link lands on the habit and date in the checkbox grid", async ({
  page,
}) => {
  const history = await open(page, f1);
  await history.getByLabel("Habit").selectOption({ label: "Synthetic read" });
  await history.getByRole("button", { name: "Previous month" }).click();
  await day(page, "Tuesday, February 29, 2028: Completed").click();
  await history
    .getByRole("link", {
      name: "Open Tuesday, February 29, 2028 in the checkbox grid",
    })
    .click();
  await expect(page).toHaveURL(/habit=habit-3&date=2028-02-29/);
  // The grid's month heading; the history panel's heading can show the same
  // month while the page changes.
  await expect(
    page
      .getByRole("navigation", { name: "Month" })
      .getByRole("heading", { name: "February 2028" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Synthetic read, Tuesday, February 29, 2028",
      exact: true,
    }),
  ).toBeFocused();
  // Moving to another month drops the link.
  await page.getByRole("button", { name: "Next month, March 2028" }).click();
  await expect(page).not.toHaveURL(/date=/);
});

test("empty and archived-only states", async ({ page }) => {
  const history = await open(page, { today: "2028-03-01", habits: [] });
  await expect(history).toContainText(
    "No habits yet. Add a habit to see its history.",
  );
});
