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
  await page.goto("/calendar?view=month");
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
  await page.getByRole("button", { name: "Month", exact: true }).click();

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
  await page.goto("/calendar?view=month");
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
  await page.goto("/calendar?view=month");
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
  await page.goto("/calendar?view=month");
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
      .then(() =>
        page.locator(".calendar-day-panel").getByRole("button", { name }),
      );

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

test.describe("timeline views", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-18T14:20:00+01:00"));
    await page.addInitScript(() =>
      Object.assign(window, {
        __seedIssues: [{ title: "Send invoice", dueDate: "2026-11-19" }],
        __seedEvents: [
          {
            title: "Standup",
            startLocal: "2026-11-18T09:00",
            endLocal: "2026-11-18T09:30",
          },
          {
            title: "Design review",
            startLocal: "2026-11-18T09:15",
            endLocal: "2026-11-18T10:30",
          },
          {
            title: "Saturday run",
            startLocal: "2026-11-21T08:00",
            endLocal: "2026-11-21T09:00",
          },
          {
            title: "Offsite",
            allDay: true,
            startDate: "2026-11-19",
            endDate: "2026-11-21",
            timeZone: null,
          },
        ],
      }),
    );
  });

  test("opens on Week and shows the same items in Day and Workweek", async ({
    page,
  }) => {
    await page.goto("/calendar");
    const views = page.getByRole("group", { name: "Calendar view" });
    await expect(
      views.getByRole("button", { name: "Week", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("heading", { name: "November 16 – 22, 2026" }),
    ).toBeVisible();
    const wednesday = page.getByRole("group", {
      name: "Wednesday, November 18",
    });
    const review = wednesday.getByRole("button", { name: /Design review/ });
    await expect(review).toBeVisible();
    await expect(
      page
        .getByRole("group", { name: "Saturday, November 21" })
        .getByRole("button", {
          name: /Saturday run/,
        }),
    ).toBeVisible();
    const allDay = page.getByRole("group", { name: "All day" });
    await expect(allDay.getByRole("button", { name: /Offsite/ })).toBeVisible();
    await expect(
      allDay.getByRole("link", { name: "Deadline: ISS-1 Send invoice" }),
    ).toBeVisible();
    const top = await review.evaluate(
      (element) => element.parentElement!.style.top,
    );

    // Workweek leaves the weekend out; Day shows one date.
    await views.getByRole("button", { name: "Workweek" }).click();
    await expect(page.getByRole("group", { name: /Saturday/ })).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "Friday, November 20" }),
    ).toBeVisible();
    await expect(review).toBeVisible();
    await views.getByRole("button", { name: "Day" }).click();
    await expect(
      page.getByRole("heading", { name: "Wednesday, November 18, 2026" }),
    ).toBeVisible();
    await expect(review).toBeVisible();
    expect(
      await review.evaluate((element) => element.parentElement!.style.top),
    ).toBe(top);

    // Previous, Next, and Today.
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(
      page.getByRole("heading", { name: "Thursday, November 19, 2026" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Today" }).click();
    await expect(
      page.getByRole("heading", { name: "Wednesday, November 18, 2026" }),
    ).toBeVisible();
    // An empty day still shows its grid.
    await page.getByRole("button", { name: "Previous day" }).click();
    await page.getByRole("button", { name: "Previous day" }).click();
    await expect(
      page.getByRole("group", { name: "Monday, November 16" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("group", { name: "Monday, November 16" })
        .getByRole("button"),
    ).toHaveCount(0);
  });

  test("lays out overlaps side by side and works by keyboard", async ({
    page,
  }) => {
    await page.goto("/calendar?view=day&date=2026-11-18");
    const standup = page.getByRole("button", { name: /Standup/ });
    const review = page.getByRole("button", { name: /Design review/ });
    const a = (await standup.boundingBox())!;
    const b = (await review.boundingBox())!;
    // Side by side: no horizontal overlap, and vertically overlapping.
    expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1);
    expect(a.y).toBeLessThan(b.y + b.height);
    expect(b.y).toBeLessThan(a.y + a.height);
    await expect(standup).toHaveAccessibleName(
      /09:00–09:30\s*Standup.*Blue calendar\. Edit event\./,
    );

    // Keyboard: open, close, and return focus.
    await standup.focus();
    await page.keyboard.press("Enter");
    const editor = page.getByRole("dialog", { name: "Edit event" });
    await expect(editor.getByLabel("Title")).toHaveValue("Standup");
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await expect(standup).toBeFocused();

    // The now line is on today's column.
    await expect(page.locator(".timeline-now")).toHaveCount(1);
  });

  test("creates an event at the clicked time, snapped to the grid", async ({
    page,
  }) => {
    await page.goto("/calendar?view=day&date=2026-11-20");
    await page
      .getByRole("combobox", { name: "Grid", exact: true })
      .selectOption("15");
    const day = page.getByRole("group", { name: "Friday, November 20" });
    const hour = (await day.boundingBox())!.height / 24;
    // Bring 15:00 into view, then click 15:20, which snaps down to 15:15.
    await page
      .locator(".timeline-scroll")
      .evaluate((element, top) => (element.scrollTop = top), hour * 14.5);
    const box = (await day.boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + hour * (15 + 20 / 60));
    const editor = page.getByRole("dialog", { name: "New event" });
    await expect(editor.getByLabel("Start date")).toHaveValue("2026-11-20");
    await expect(editor.getByLabel("Start time")).toHaveValue("15:15");
    await expect(editor.getByLabel("End time")).toHaveValue("16:15");
    await editor.getByLabel("Title").fill("Call the bank");
    await editor.getByLabel("Title").press("Enter");
    await expect(
      day.getByRole("button", { name: /15:15–16:15\s*Call the bank/ }),
    ).toBeVisible();
    // The grid setting is remembered.
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Grid", exact: true }),
    ).toHaveValue("15");
  });

  test("places items by wall clock on a daylight-saving day", async ({
    page,
  }) => {
    // Clocks in Paris jump from 02:00 to 03:00 on 29 March 2026.
    await page.addInitScript(() =>
      Object.assign(window, {
        __seedEvents: [
          {
            title: "Early train",
            startLocal: "2026-03-29T03:00",
            endLocal: "2026-03-29T04:00",
          },
        ],
      }),
    );
    await page.goto("/calendar?view=day&date=2026-03-29");
    const train = page.getByRole("button", {
      name: /03:00–04:00\s*Early train/,
    });
    await expect(train).toBeVisible();
    expect(
      await train.evaluate((element) => element.parentElement!.style.top),
    ).toBe("12.5%");
  });
});

test("opens a multi-day event from Month and Agenda", async ({ page }) => {
  await page.addInitScript(() =>
    Object.assign(window, {
      __seedEvents: [
        {
          title: "Research retreat",
          startLocal: "2026-11-16T15:00",
          endLocal: "2026-11-17T10:00",
        },
      ],
    }),
  );
  await page.goto("/calendar?view=month&date=2026-11-16");
  const grid = page.getByRole("table");
  await expect(
    grid.getByRole("button", { name: /Research retreat/ }),
  ).toHaveCount(2);
  await grid
    .getByRole("button", { name: /Continues.*Research retreat/ })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Edit event" }).getByLabel("Title"),
  ).toHaveValue("Research retreat");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  await expect(
    page
      .getByLabel("Agenda", { exact: true })
      .getByRole("button", { name: /Research retreat/ }),
  ).toHaveCount(2);
});

test("restores calendar preferences and honors explicit deep links", async ({
  page,
}) => {
  await page.goto("/calendar");
  await page.getByText("Calendar preferences", { exact: true }).click();
  await page.getByLabel("Default view").selectOption("month");
  await page.getByLabel("First day of week").selectOption("0");
  await page.getByLabel("Time format").selectOption("12");
  await page.getByRole("button", { name: "Save calendar preferences" }).click();
  await page.reload();
  await expect(page.getByRole("columnheader").first()).toHaveText("Sun");
  await page.goto("/calendar?view=day&date=2026-12-01");
  await expect(page.getByLabel("Go to date")).toHaveValue("2026-12-01");
  await expect(page.locator(".timeline-hours")).toContainText("1:00 PM");
  await page.getByLabel("Go to date").fill("2026-12-07");
  await expect(page).toHaveURL(/date=2026-12-07/);
  await page.goto("/calendar");
  await expect(
    page.getByRole("button", { name: "Month", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() =>
    localStorage.setItem(
      "unhollowed-2-calendar",
      JSON.stringify({
        version: 1,
        view: "month",
        weekStart: "0",
      }),
    ),
  );
  await page.reload();
  await expect(page.getByRole("columnheader").first()).toHaveText("Mon");
});

test("drags out a range, resizes, and confirms a moved appointment", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, {
      __seedEvents: [
        {
          title: "Schedule review",
          timeZone: "Europe/Paris",
          startLocal: "2026-11-16T09:00",
          endLocal: "2026-11-16T10:30",
          startAt: "2026-11-16T08:00:00Z",
          endAt: "2026-11-16T09:30:00Z",
        },
      ],
    }),
  );
  await page.goto("/calendar?view=week&date=2026-11-16");
  const monday = page.getByRole("group", { name: "Monday, November 16" });
  const tuesday = page.getByRole("group", { name: "Tuesday, November 17" });
  const event = monday.getByRole("button", { name: /Schedule review/ });
  await expect(event).toBeVisible();
  const second = (await tuesday.boundingBox())!;
  const hour = second.height / 24;
  async function drag(x: number, y: number, endX: number, endY: number) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 6 });
    await page.mouse.up();
  }
  await drag(
    second.x + 25,
    second.y + hour * 9.1,
    second.x + 25,
    second.y + hour * 10.1,
  );
  const editor = page.getByRole("dialog", { name: "New event" });
  await expect(editor.getByLabel("Start time")).toHaveValue("09:00");
  await expect(editor.getByLabel("End time")).toHaveValue("10:30");
  await page.keyboard.press("Escape");

  const edit = page.getByRole("dialog", { name: "Edit event" });
  const first = (await monday.boundingBox())!;
  const handle = (await event.locator("[data-resize]").boundingBox())!;
  await drag(handle.x + 12, handle.y + 2, first.x + 25, first.y + hour * 11.1);
  await expect(edit.getByLabel("End time")).toHaveValue("11:00");
  await page.keyboard.press("Escape");
  await expect(event).toContainText("09:00–10:30");

  const box = (await event.boundingBox())!;
  const destination = (await tuesday.boundingBox())!;
  await drag(
    box.x + 12,
    box.y + 5,
    destination.x + 25,
    destination.y + hour * 11.1,
  );
  await expect(edit.getByLabel("Start date")).toHaveValue("2026-11-17");
  await expect(edit.getByLabel("Start time")).toHaveValue("11:00");
  await expect(edit.getByLabel("End time")).toHaveValue("12:30");
  await dispatch(page, "fail-once", "update_calendar_event");
  await edit.getByRole("button", { name: "Save event" }).click();
  await expect(edit.getByRole("alert")).toBeVisible();
  await expect(event).toBeAttached();
  await edit.getByRole("button", { name: "Save event" }).click();
  await expect(
    tuesday.getByRole("button", { name: /Schedule review/ }),
  ).toBeVisible();
  await expect(event).toHaveCount(0);
});

test("moves a recurring all-day event by proposing dates and an occurrence scope", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, {
      __seedEvents: [
        {
          title: "Retreat",
          allDay: true,
          startDate: "2026-11-16",
          endDate: "2026-11-18",
          repeatFreq: "weekly",
          repeatInterval: 1,
        },
      ],
    }),
  );
  await page.goto("/calendar?view=week&date=2026-11-16");
  const item = page
    .getByRole("group", { name: "All day" })
    .getByRole("button", { name: /Retreat/ });
  await expect(item).toBeVisible();
  const source = (await item.boundingBox())!;
  const target = (await page
    .locator(".timeline-day-name[data-schedule-day='2026-11-19']")
    .boundingBox())!;
  await page.mouse.move(source.x + 12, source.y + 6);
  await page.mouse.down();
  await page.mouse.move(target.x + 20, target.y + target.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  const edit = page.getByRole("dialog", { name: "Edit event" });
  await expect(edit.getByLabel("Start date")).toHaveValue("2026-11-19");
  await expect(edit.getByLabel("Last day")).toHaveValue("2026-11-20");
  await expect(edit.getByRole("radio", { name: "This event" })).toBeChecked();
  await expect(
    edit.getByRole("radio", { name: "This and following events" }),
  ).toBeVisible();
});
