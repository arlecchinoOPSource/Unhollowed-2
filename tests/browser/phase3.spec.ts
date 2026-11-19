import { expect, test } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

// The Phase 3 workflow in one pass, in both themes: create an event, link it,
// remind, schedule work on an issue, find it, see it on Today, and exchange a
// file. The IPC is mocked, so persistence across restart is covered by the
// Rust journey in `scheduling/journey.rs`, not here.
test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

for (const scheme of ["light", "dark"] as const) {
  test(`create, link, remind, schedule, search, and exchange in ${scheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await installIpcMock(page);
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00+01:00"));
    await page.addInitScript(() =>
      Object.assign(window, {
        __seedDocuments: ["Kickoff notes"],
        __seedIssues: [{ title: "Write the plan", dueDate: "2026-11-20" }],
        __icsFile: {
          name: "team.ics",
          content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        },
      }),
    );

    // Create an event from the Month view.
    await page.goto("/calendar?view=month");
    await page.getByRole("button", { name: /November 18, 2026/ }).click();
    const panel = page.getByRole("region", { name: /November 18, 2026/ });
    await panel.getByRole("button", { name: "New event" }).click();
    const editor = page.getByRole("dialog", { name: "New event" });
    await editor.getByLabel("Start time").fill("16:00");
    await editor.getByLabel("End time").fill("16:45");
    await editor.getByLabel("Title").fill("Kickoff review");
    await editor.getByLabel("Title").press("Enter");
    await expect(editor).toBeHidden();

    // Link a document and project, and set a reminder.
    await panel
      .getByRole("button", { name: /16:00–16:45\s*Kickoff review/ })
      .click();
    const edit = page.getByRole("dialog", { name: "Edit event" });
    await edit.getByText("Reminder", { exact: true }).click();
    await edit.getByLabel("Reminder").selectOption("15");
    await edit.getByText("Documents and projects").click();
    await edit
      .getByLabel("Link a document")
      .selectOption({ label: "Kickoff notes" });
    await edit.getByRole("button", { name: "Link document" }).click();
    await edit
      .getByLabel("Link a project")
      .selectOption({ label: "Studio launch" });
    await edit.getByRole("button", { name: "Link project" }).click();
    await expect(
      edit.getByRole("link", { name: "Kickoff notes" }),
    ).toBeVisible();
    await expect(
      edit.getByRole("link", { name: "Studio launch" }),
    ).toBeVisible();
    await edit.getByRole("button", { name: "Cancel" }).click();

    // Schedule work on the issue without changing its due date.
    await page
      .getByRole("link", { name: /Write the plan/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Schedule work session" }).click();
    const form = page.getByRole("form", { name: "New session" });
    await form.getByLabel("Date", { exact: true }).fill("2026-11-18");
    await form.getByLabel("Start").fill("14:00");
    await form.getByLabel("End").fill("15:30");
    await form.getByRole("button", { name: "Add session" }).click();
    await expect(page.getByText("Session added.")).toBeVisible();

    // Search finds the event, and the Week view shows every kind apart.
    await page.getByRole("link", { name: /Wednesday, November 18/ }).click();
    await expect(page.getByText("Work block:").first()).toBeVisible();
    await expect(page.getByText("Deadline:").first()).toBeVisible();
    await page.getByRole("button", { name: "Search calendar" }).click();
    await page.getByRole("combobox", { name: /Search titles/ }).fill("kickoff");
    await expect(
      page.getByRole("option", { name: /Kickoff review/ }),
    ).toBeVisible();
    await page
      .getByRole("group", { name: "Calendar view" })
      .getByRole("button", { name: "Month" })
      .click();
    await expect(
      page.getByRole("combobox", { name: /Search titles/ }),
    ).toHaveValue("kickoff");
    await expect(
      page.getByRole("option", { name: /Kickoff review/ }),
    ).toBeVisible();

    // Today shows its schedule and context, on the day itself.
    const nav = page.getByRole("navigation", { name: "Workspace" });
    await nav.getByRole("link", { name: "Today" }).click();
    await expect(page.getByRole("region", { name: "Schedule" })).toBeVisible();

    // Exchange: preview and import a file, then export.
    await nav.getByRole("link", { name: "Calendar" }).click();
    const transfer = page.locator("details", { hasText: "Import and export" });
    await transfer.locator("summary").click();
    await transfer
      .getByRole("button", { name: "Choose a file to import…" })
      .click();
    await transfer.getByRole("button", { name: /^Import \d/ }).click();
    await expect(
      transfer.getByText("Imported 2 events.").first(),
    ).toBeVisible();
    await transfer.getByRole("button", { name: "Export calendar…" }).click();
    await expect(transfer.getByRole("status")).toContainText("Saved");
  });
}
