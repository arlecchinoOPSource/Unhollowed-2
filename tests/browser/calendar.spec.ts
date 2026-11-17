import { expect, test } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

test.beforeEach(({ page }) => installIpcMock(page));

test("manages calendars: create, hide, default, archive with a replacement, and restore", async ({
  page,
}) => {
  await page.goto("/calendar");
  await page.getByRole("link", { name: "Manage calendars" }).click();
  await expect(
    page.getByRole("heading", { name: "Calendars", exact: true }),
  ).toBeVisible();
  const active = page.getByRole("list").first();
  await expect(active.getByText("Personal (default)")).toBeVisible();

  // Create a calendar by keyboard.
  const create = page.getByRole("form", { name: "Create a calendar" });
  await create.getByLabel("Calendar name").fill("Work");
  await create.getByLabel("Color").selectOption("teal");
  await create.getByLabel("Description (optional)").fill("Office hours");
  await create.getByLabel("Description (optional)").press("Enter");
  await expect(page.getByRole("status")).toHaveText("Created calendar Work.");
  await expect(create.getByLabel("Calendar name")).toBeFocused();
  await expect(page.getByText("Office hours")).toBeVisible();

  // Names are unique, ignoring case.
  await create.getByLabel("Calendar name").fill("work");
  await create.getByRole("button", { name: "Create calendar" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Another calendar already has this name.",
  );

  // Hide and show.
  const show = page.getByRole("checkbox", {
    name: "Show Work in calendar views",
  });
  await show.uncheck();
  await expect(page.getByRole("status")).toHaveText(
    "Work is hidden from calendar views.",
  );
  await expect(show).not.toBeChecked();

  // Make Work the default; Personal can then be archived directly.
  await page.getByRole("button", { name: "Make Work the default" }).click();
  await expect(page.getByText("Work (default)")).toBeVisible();
  await expect(page.getByText("Personal (default)")).toHaveCount(0);
  await page.getByRole("button", { name: "Archive Personal" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Archived Personal. Its events are kept.",
  );
  await expect(
    page.getByRole("heading", { name: "Archived calendars" }),
  ).toBeVisible();

  // The only active calendar is the default, so it cannot be archived yet.
  const archiveWork = page.getByRole("button", { name: "Archive Work" });
  await archiveWork.click();
  await expect(archiveWork).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("form", { name: "Archive Work" }).getByRole("alert"),
  ).toContainText("Create another calendar to become the default");
  await page
    .getByRole("form", { name: "Archive Work" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(archiveWork).toBeFocused();

  // Restore Personal, then archive Work with Personal as the new default.
  await page.getByRole("button", { name: "Restore Personal" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Restored Personal and its events.",
  );
  await archiveWork.click();
  const replace = page.getByRole("form", { name: "Archive Work" });
  await expect(replace.getByLabel("New default calendar")).toBeFocused();
  await expect(replace.getByLabel("New default calendar")).toHaveValue(
    "calendar-personal",
  );
  await replace.getByRole("button", { name: "Archive Work" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Archived Work. Its events are kept. Personal is now the default calendar.",
  );
  await expect(page.getByText("Personal (default)")).toBeVisible();

  // Edits keep working on archived calendars.
  await page.getByRole("button", { name: "Edit Work" }).click();
  const edit = page.getByRole("form", { name: "Edit Work" });
  await expect(edit.getByLabel("Calendar name")).toBeFocused();
  await edit.getByLabel("Calendar name").fill("Office");
  await edit.getByRole("button", { name: "Save calendar" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved calendar Office.");
  await expect(page.getByRole("button", { name: "Edit Office" })).toBeFocused();
});
