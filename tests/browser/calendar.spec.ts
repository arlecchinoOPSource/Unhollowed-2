import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

// Dates and times are local, so pin the zone and clock.
test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

test.beforeEach(async ({ page }) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-16T10:00:00+01:00"));
});

function day(page: Page, date: RegExp) {
  return page.getByRole("button", { name: date });
}

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

test("creates, edits, duplicates, moves, and deletes events in the editor", async ({
  page,
}) => {
  // Set up a second calendar first, through the app.
  await page.goto("/calendar/calendars");
  const create = page.getByRole("form", { name: "Create a calendar" });
  await create.getByLabel("Calendar name").fill("Work");
  await create.getByLabel("Calendar name").press("Enter");
  await expect(page.getByRole("status")).toHaveText("Created calendar Work.");
  await page.getByRole("link", { name: "Calendar" }).first().click();

  await day(page, /November 18, 2026/).click();
  const panel = page.getByRole("region", { name: /November 18, 2026/ });
  await expect(panel.getByText("No events this day.")).toBeVisible();

  // Quick create by keyboard: the title has focus, Enter saves.
  const newEvent = panel.getByRole("button", { name: "New event" });
  await newEvent.click();
  const editor = page.getByRole("dialog", { name: "New event" });
  await expect(editor.getByLabel("Title")).toBeFocused();
  await editor.getByLabel("Start time").fill("09:30");
  await editor.getByLabel("End time").fill("10:15");
  await editor.getByLabel("Title").fill("Standup");
  await editor.getByLabel("Title").press("Enter");
  await expect(page.getByRole("status").first()).toHaveText(
    "Created event Standup.",
  );
  await expect(editor).toBeHidden();
  await expect(newEvent).toBeFocused();
  const standup = panel.getByRole("button", { name: /09:30–10:15\s*Standup/ });
  await expect(standup).toBeVisible();

  // Invalid input keeps the dialog and every entered value.
  await standup.click();
  const edit = page.getByRole("dialog", { name: "Edit event" });
  await edit.getByText("More details").click();
  await edit.getByLabel("Location (optional)").fill("Room 4");
  await edit.getByLabel("Link (optional)").fill("javascript:alert(1)");
  await edit.getByRole("button", { name: "Save event" }).click();
  await expect(edit.getByRole("alert")).toHaveText(
    "Enter a web address starting with http:// or https://.",
  );
  await expect(edit.getByLabel("Location (optional)")).toHaveValue("Room 4");
  await edit.getByLabel("End time").fill("09:00");
  await edit.getByRole("button", { name: "Save event" }).click();
  await expect(edit.getByRole("alert")).toHaveText("End after the start.");

  // A failed write keeps the values too.
  await edit.getByLabel("End time").fill("10:15");
  await edit.getByLabel("Link (optional)").fill("https://example.com/notes");
  await dispatch(page, "fail-command", "update_calendar_event");
  await edit.getByRole("button", { name: "Save event" }).click();
  await expect(edit.getByRole("alert")).toHaveText(
    "Could not save the change. Try again.",
  );
  await expect(edit.getByLabel("Link (optional)")).toHaveValue(
    "https://example.com/notes",
  );
  await dispatch(page, "restore-command", "update_calendar_event");

  // Move it to Work while saving.
  await edit.getByLabel("Calendar").selectOption({ label: "Work (Teal)" });
  await edit.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByRole("status").first()).toHaveText(
    "Saved event Standup.",
  );
  await expect(
    panel.getByRole("button", { name: /Teal calendar/ }),
  ).toBeVisible();

  // Duplicate, then edit the copy.
  await standup.click();
  await edit.getByRole("button", { name: "Duplicate" }).click();
  await expect(edit.getByRole("status")).toHaveText(
    "Duplicated. You are now editing the copy.",
  );
  await edit.getByLabel("Title").fill("Standup notes");
  await edit.getByRole("button", { name: "Save event" }).click();
  await expect(
    panel.getByRole("button", { name: /Standup notes/ }),
  ).toBeVisible();
  await expect(panel.getByRole("listitem")).toHaveCount(2);

  // Delete needs confirmation, and Keep cancels.
  await panel.getByRole("button", { name: /Standup notes/ }).click();
  await edit.getByRole("button", { name: "Delete…" }).click();
  const confirm = edit.getByRole("group", { name: "Confirm deletion" });
  await expect(
    confirm.getByRole("button", { name: "Delete event" }),
  ).toBeFocused();
  await confirm.getByRole("button", { name: "Keep event" }).click();
  await edit.getByRole("button", { name: "Delete…" }).click();
  await confirm.getByRole("button", { name: "Delete event" }).click();
  await expect(page.getByRole("status").first()).toHaveText(
    "Deleted event Standup notes.",
  );
  await expect(panel.getByRole("listitem")).toHaveCount(1);

  // Escape closes without saving.
  await standup.click();
  await edit.getByLabel("Title").fill("Never saved");
  await page.keyboard.press("Escape");
  await expect(edit).toBeHidden();
  await expect(standup).toBeVisible();
});

test("shows a multi-day all-day event on each of its days", async ({
  page,
}) => {
  await page.goto("/calendar");
  await day(page, /November 18, 2026/).click();
  await page.getByRole("button", { name: "New event" }).click();
  const editor = page.getByRole("dialog", { name: "New event" });
  await editor.getByLabel("Title").fill("Conference");
  await editor.getByLabel("All day").check();
  await expect(editor.getByLabel("Start time")).toHaveCount(0);
  await editor.getByLabel("Last day").fill("2026-11-19");
  await editor.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByRole("status").first()).toHaveText(
    "Created event Conference.",
  );
  for (const [date, count] of [
    [/November 18, 2026/, 1],
    [/November 19, 2026/, 1],
    [/November 20, 2026/, 0],
  ] as const) {
    await day(page, date).click();
    await expect(
      page.getByRole("button", { name: /All day\s*Conference/ }),
    ).toHaveCount(count);
  }
});

test("shows events from another zone at the viewer's time with their own", async ({
  page,
}) => {
  // 09:00–10:00 in Tokyo is 01:00–02:00 in Paris.
  await page.addInitScript(() =>
    Object.assign(window, {
      __seedEvents: [
        {
          title: "Tokyo sync",
          timeZone: "Asia/Tokyo",
          startLocal: "2026-11-18T09:00",
          endLocal: "2026-11-18T10:00",
          startAt: "2026-11-18T00:00:00Z",
          endAt: "2026-11-18T01:00:00Z",
        },
      ],
    }),
  );
  await page.goto("/calendar");
  await day(page, /November 18, 2026/).click();
  const event = page.getByRole("button", {
    name: /01:00–02:00\s*Tokyo sync\s*09:00 Asia\/Tokyo/,
  });
  await expect(event).toBeVisible();
  await event.click();
  const editor = page.getByRole("dialog", { name: "Edit event" });
  await expect(editor.getByLabel("Start time")).toHaveValue("09:00");
  await expect(editor.getByText("Times are in Asia/Tokyo.")).toBeVisible();
});

test("repeats an event and edits one occurrence, this and following, or all", async ({
  page,
}) => {
  await page.goto("/calendar");
  await day(page, /November 18, 2026/).click();
  await page.getByRole("button", { name: "New event" }).click();
  const editor = page.getByRole("dialog", { name: "New event" });
  await editor.getByLabel("Title").fill("Class");
  await editor.getByLabel("Start time").fill("18:00");
  await editor.getByLabel("End time").fill("19:00");
  await editor.getByLabel("Repeats").selectOption("weekly");
  await editor.getByLabel("Ends").selectOption("count");
  await editor.getByRole("spinbutton", { name: "Number of times" }).fill("4");
  await editor.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByRole("status").first()).toHaveText(
    "Created event Class.",
  );
  const occurrence = (date: RegExp, name: RegExp) =>
    day(page, date)
      .click()
      .then(() => page.getByRole("button", { name }));

  // One occurrence: renamed, and the rest of the series keeps its title.
  await (
    await occurrence(/November 25, 2026/, /18:00–19:00\s*Class\s*Repeats/)
  ).click();
  const edit = page.getByRole("dialog", { name: "Edit event" });
  await expect(edit.getByRole("radio", { name: "This event" })).toBeChecked();
  // A single occurrence cannot change the repeat.
  await expect(edit.getByLabel("Repeats")).toHaveCount(0);
  await edit.getByLabel("Title").fill("Class in room 2");
  await edit.getByRole("button", { name: "Save event" }).click();
  await expect(
    await occurrence(/November 25, 2026/, /Class in room 2/),
  ).toBeVisible();
  await expect(
    await occurrence(/December 2, 2026/, /^18:00–19:00\s*Class\s*Repeats/),
  ).toBeVisible();

  // Cancel one occurrence only.
  await (await occurrence(/December 2, 2026/, /Class/)).click();
  await edit.getByRole("button", { name: "Delete…" }).click();
  const confirm = edit.getByRole("group", { name: "Confirm deletion" });
  await expect(
    confirm.getByRole("button", { name: "Delete this event" }),
  ).toBeFocused();
  await confirm.getByRole("button", { name: "Delete this event" }).click();
  await day(page, /December 2, 2026/).click();
  await expect(page.getByText("No events this day.")).toBeVisible();
  await expect(await occurrence(/December 9, 2026/, /Class/)).toBeVisible();

  // This and following: later, from 9 December on.
  await (await occurrence(/December 9, 2026/, /Class/)).click();
  await edit.getByRole("radio", { name: "This and following events" }).check();
  await expect(edit.getByLabel("Repeats")).toHaveValue("weekly");
  await edit.getByLabel("Start time").fill("19:00");
  await edit.getByLabel("End time").fill("20:00");
  await edit.getByRole("button", { name: "Save event" }).click();
  await expect(
    await occurrence(/December 9, 2026/, /19:00–20:00\s*Class/),
  ).toBeVisible();
  // Earlier occurrences keep their time.
  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(
    await occurrence(/November 18, 2026/, /18:00–19:00\s*Class/),
  ).toBeVisible();
});
