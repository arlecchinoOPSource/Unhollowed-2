import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const seed = [
  {
    date: "2026-11-10",
    mood: 3,
    energy: null,
    focus: 2,
    note: "Private words",
  },
  { date: "2026-11-12", mood: null, energy: 4, focus: null, note: null },
];

async function open(page: Page, checkins: object[] = seed) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((value) => {
    Object.assign(window, { __seedCheckins: value });
  }, checkins);
  await page.goto("/mood");
  await expect(
    page.getByRole("heading", { name: "Tuesday, November 17, 2026" }),
  ).toBeVisible();
}

const radio = (page: Page, group: string, value: string) =>
  page
    .getByRole("group", { name: new RegExp(`^${group}`) })
    .getByRole("radio", { name: value, exact: true });

const stored = (page: Page) =>
  page.evaluate(() =>
    Object.keys(
      (window as unknown as { __checkins: Record<string, unknown> }).__checkins,
    ),
  );

test("saves any subset, leaves the rest visibly unset, and shows it again", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByText("No check-in for this day yet.")).toBeVisible();
  for (const group of ["Mood", "Energy", "Focus"])
    await expect(radio(page, group, "Not set")).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Save check-in" }),
  ).toBeDisabled();

  await radio(page, "Mood", "4").check();
  await page.getByRole("button", { name: "Save check-in" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Saved your check-in for Tuesday, November 17, 2026.",
  );
  await expect(radio(page, "Energy", "Not set")).toBeChecked();
  await expect(radio(page, "Focus", "Not set")).toBeChecked();

  // Another day and back: the stored record is shown for the selected date.
  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(
    page.getByRole("heading", { name: "Monday, November 16, 2026" }),
  ).toBeVisible();
  await expect(radio(page, "Mood", "Not set")).toBeChecked();
  await page.getByRole("button", { name: "Today" }).click();
  await expect(radio(page, "Mood", "4")).toBeChecked();
  await expect(radio(page, "Energy", "Not set")).toBeChecked();
});

test("a historical entry can be opened and edited", async ({ page }) => {
  await open(page);
  await page.getByLabel("Date").fill("2026-11-10");
  await expect(
    page.getByRole("heading", { name: "Tuesday, November 10, 2026" }),
  ).toBeVisible();
  await expect(radio(page, "Mood", "3")).toBeChecked();
  await expect(radio(page, "Energy", "Not set")).toBeChecked();
  await expect(radio(page, "Focus", "2")).toBeChecked();
  await expect(page.getByLabel("Note (optional)")).toHaveValue("Private words");

  await radio(page, "Energy", "5").check();
  await page.getByLabel("Note (optional)").fill("Edited later");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Saved your check-in");
  expect(await stored(page)).toEqual(["2026-11-10", "2026-11-12"]);

  // The recent list opens a day, and never shows note text.
  const recent = page.getByRole("list").filter({ hasText: "November 12" });
  await expect(recent).toContainText(
    "Mood not set, energy 4 of 5, focus not set",
  );
  await expect(page.getByRole("list")).not.toContainText("Edited later");
  await expect(recent).toContainText("has a note");
  await recent
    .getByRole("button", { name: "Thursday, November 12, 2026" })
    .click();
  await expect(radio(page, "Energy", "4")).toBeChecked();
});

test("an empty entry stores nothing and removes an existing one", async ({
  page,
}) => {
  await open(page);
  // Setting a rating and clearing it again leaves nothing to save.
  await radio(page, "Focus", "3").check();
  await expect(
    page.getByRole("button", { name: "Save check-in" }),
  ).toBeEnabled();
  await radio(page, "Focus", "Not set").check();
  await expect(
    page.getByRole("button", { name: "Save check-in" }),
  ).toBeDisabled();

  await page.getByLabel("Date").fill("2026-11-12");
  await expect(radio(page, "Energy", "4")).toBeChecked();
  await radio(page, "Energy", "Not set").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Removed the check-in for Thursday, November 12, 2026, because nothing was left in it.",
  );
  expect(await stored(page)).toEqual(["2026-11-10"]);
  await expect(page.getByText("No check-in for this day yet.")).toBeVisible();
});

test("a failed save keeps the draft and can be retried", async ({ page }) => {
  await open(page);
  await radio(page, "Mood", "2").check();
  await page.getByLabel("Note (optional)").fill("Typed, not yet saved");
  await dispatch(page, "fail-once", "save_checkin");
  await page.getByRole("button", { name: "Save check-in" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not save");
  await expect(radio(page, "Mood", "2")).toBeChecked();
  await expect(page.getByLabel("Note (optional)")).toHaveValue(
    "Typed, not yet saved",
  );
  expect(await stored(page)).toEqual(["2026-11-10", "2026-11-12"]);

  await page.getByRole("button", { name: "Save check-in" }).click();
  await expect(page.getByRole("status")).toContainText("Saved your check-in");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("unsaved changes are never dropped by changing the day", async ({
  page,
}) => {
  await open(page);
  await radio(page, "Mood", "5").check();
  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Save or discard your changes before choosing another day.",
  );
  await expect(
    page.getByRole("heading", { name: "Tuesday, November 17, 2026" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(radio(page, "Mood", "Not set")).toBeChecked();
  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(
    page.getByRole("heading", { name: "Monday, November 16, 2026" }),
  ).toBeVisible();
});

test("ratings work by keyboard and the future cannot be chosen", async ({
  page,
}) => {
  await open(page);
  await radio(page, "Mood", "Not set").focus();
  await page.keyboard.press("ArrowRight");
  await expect(radio(page, "Mood", "1")).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(radio(page, "Mood", "2")).toBeChecked();
  await expect(page.getByRole("button", { name: "Next day" })).toBeDisabled();
  await expect(page.getByLabel("Date")).toHaveAttribute("max", "2026-11-17");
});
