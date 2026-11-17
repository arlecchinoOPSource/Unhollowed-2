import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const seed = {
  today: "2026-11-17",
  habits: [
    { name: "Walk", startDate: "2026-11-05" },
    { name: "Read", startDate: "2026-11-01", archivedOn: "2026-11-12" },
    { name: "Later", startDate: "2026-12-01" },
  ],
  completions: [
    ["habit-1", "2026-11-10"],
    ["habit-2", "2026-11-12"],
  ],
};

async function open(page: Page, habitSeed: object = seed) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((value) => {
    Object.assign(window, { __seedHabits: value });
  }, habitSeed);
  await page.goto("/habits");
  await page.getByRole("button", { name: "Manage habits" }).click();
  return page.getByRole("dialog", { name: "Manage habits" });
}

const names = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __habits: { habits: { name: string }[] } }
    ).__habits.habits.map((habit) => habit.name),
  );

test("renames a habit, keeps its history, and returns focus to Rename", async ({
  page,
}) => {
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "Rename Walk" }).click();
  const input = dialog.getByLabel("New name for Walk");
  await expect(input).toBeFocused();
  await input.fill("later");
  await dialog.getByRole("button", { name: "Save name" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "An active habit already has this name. Choose a different name.",
  );
  await input.fill("Stroll");
  await input.press("Enter");
  await expect(dialog.getByRole("status")).toHaveText("Renamed to Stroll.");
  await expect(
    dialog.getByRole("button", { name: "Rename Stroll" }),
  ).toBeFocused();

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(
    page.getByRole("button", {
      name: "Stroll, Tuesday, November 10, 2026",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  // Closing returns focus to the button that opened the dialog.
  await expect(
    page.getByRole("button", { name: "Manage habits" }),
  ).toBeFocused();
});

test("Escape cancels a rename without closing the dialog", async ({ page }) => {
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "Rename Walk" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Rename Walk" }),
  ).toBeFocused();
  expect(await names(page)).toContain("Walk");
});

test("reorders habits by keyboard and keeps focus on a move control", async ({
  page,
}) => {
  const dialog = await open(page);
  const down = dialog.getByRole("button", { name: "Move Walk down" });
  await expect(
    dialog.getByRole("button", { name: "Move Walk up" }),
  ).toBeDisabled();
  await down.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("status")).toHaveText("Moved Walk down.");
  expect(await names(page)).toEqual(["Later", "Read", "Walk"]);
  // Walk is now last, so focus moves to its remaining move control.
  await expect(
    dialog.getByRole("button", { name: "Move Walk up" }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("list", { name: "Active habits" }).getByRole("listitem"),
  ).toHaveText([/Later/, /Walk/]);
});

test("archives and restores a habit with its history intact", async ({
  page,
}) => {
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "Archive Walk" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Archived Walk. Its history is kept.",
  );
  const archived = dialog.getByRole("list", { name: "Archived habits" });
  await expect(archived).toContainText("Walk");
  await expect(archived).toContainText("Archived Tuesday, November 17, 2026");
  await expect(
    dialog.getByRole("button", { name: "Restore Walk" }),
  ).toBeFocused();

  await dialog.getByText("History of Walk").click();
  await expect(
    dialog.getByRole("list", { name: "Completed days, Walk" }),
  ).toHaveText("Tuesday, November 10, 2026");

  await dialog.getByRole("button", { name: "Restore Walk" }).click();
  await expect(
    dialog.getByRole("list", { name: "Active habits" }),
  ).toContainText("Walk");
  await expect(
    dialog.getByRole("button", { name: "Rename Walk" }),
  ).toBeFocused();
});

test("empty states", async ({ page }) => {
  const dialog = await open(page, { today: "2026-11-17", habits: [] });
  await expect(dialog.getByText(/No active habits/)).toBeVisible();
  await expect(dialog.getByText("No archived habits.")).toBeVisible();
});

test("delete shows its impact first and Cancel keeps everything", async ({
  page,
}) => {
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "Delete Read permanently" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Delete Read permanently?" }),
  ).toBeFocused();
  await expect(dialog).toContainText(
    "This removes 1 completed day, from Thursday, November 12, 2026 to Thursday, November 12, 2026. This cannot be undone.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await names(page)).toContain("Read");
});

test("confirmed delete removes the habit and its history", async ({ page }) => {
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "Delete Read permanently" }).click();
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Deleted Read.");
  await expect(dialog.getByText("No archived habits.")).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Archived habits" }),
  ).toBeFocused();
  expect(await names(page)).toEqual(["Walk", "Later"]);
});

test("a stale deletion is refused and re-reviewed with the current impact", async ({
  page,
}) => {
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "Delete Read permanently" }).click();
  await expect(dialog).toContainText("1 completed day");
  // Another change lands after the preview: a completion is added.
  await page.evaluate(() => {
    const state = (
      window as unknown as {
        __habits: {
          habits: { id: string; revision: number }[];
          done: Set<string>;
        };
      }
    ).__habits;
    state.done.add("habit-2|2026-11-11");
    state.habits.find((habit) => habit.id === "habit-2")!.revision += 1;
  });
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "This habit changed since you reviewed it. Review the deletion again.",
  );
  await expect(dialog).toContainText("2 completed days");
  expect(await names(page)).toContain("Read");

  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Deleted Read.");
});

test("a failed deletion keeps the habit and its history", async ({ page }) => {
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "Delete Read permanently" }).click();
  await dispatch(page, "fail-once", "delete_habit");
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Could not save to local habit storage. Try again.",
  );
  expect(await names(page)).toContain("Read");
  // Still under review, so a retry works.
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Deleted Read.");
});
