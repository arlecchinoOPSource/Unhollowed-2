import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

async function open(page: Page, path: string, links: string[][] = []) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((initial) => {
    Object.assign(window, {
      __seedHabits: {
        today: "2026-11-17",
        habits: [
          { name: "Walk", startDate: "2026-11-01" },
          { name: "Read", startDate: "2026-11-01", archivedOn: "2026-11-12" },
        ],
      },
      __seedEvents: [
        {
          title: "Morning walk",
          allDay: true,
          timeZone: null,
          startDate: "2026-11-02",
          endDate: "2026-11-03",
          repeatFreq: "daily",
          repeatInterval: 1,
        },
        {
          title: "Dentist",
          allDay: true,
          timeZone: null,
          startDate: "2026-11-17",
          endDate: "2026-11-18",
        },
      ],
      __routineLinks: new Set(initial.map(([h, e]: string[]) => `${h}|${e}`)),
    });
  }, links);
  await page.goto(path);
}

test("links a habit to a repeating event, opens it, and unlinks", async ({
  page,
}) => {
  await open(page, "/habits");
  await page.getByRole("button", { name: "Manage habits" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage habits" });
  await dialog.getByText("Routines of Walk").click();
  await expect(dialog).toContainText("No repeating event linked.");
  const picker = dialog.getByLabel("Link Walk to a repeating event");
  // Only the repeating event is offered; the one-time event is not.
  await expect(picker.locator("option")).toHaveText([
    "Choose an event",
    "Morning walk (daily)",
  ]);
  await picker.selectOption({ label: "Morning walk (daily)" });
  await dialog.getByRole("button", { name: "Link routine" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Linked Walk to a routine.",
  );
  const list = dialog.getByRole("list", { name: "Routines of Walk" });
  await expect(list).toContainText("Morning walk (daily)");
  await expect(
    list.getByRole("link", { name: "Open Morning walk in the calendar" }),
  ).toHaveAttribute("href", "/calendar?date=2026-11-02");
  await expect(dialog).toContainText(
    "Every repeating event is already linked.",
  );

  await dialog
    .getByRole("button", { name: "Unlink Morning walk from Walk" })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Unlinked Morning walk from Walk.",
  );
  await expect(dialog).toContainText("No repeating event linked.");
});

test("a habit's routine appears in the daily agenda and leads back to the grid", async ({
  page,
}) => {
  await open(page, "/today", [["habit-1", "event-1"]]);
  const link = page.getByRole("link", { name: "Habit: Walk" });
  await expect(link).toHaveAttribute(
    "href",
    "/habits?habit=habit-1&date=2026-11-17",
  );
  // The one-time event has no habit context, and the agenda wrote nothing.
  await expect(page.getByRole("link", { name: /^Habit:/ })).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __habits?: { done: Set<string> } }).__habits
          ?.done.size ?? 0,
    ),
  ).toBe(0);

  await link.click();
  await expect(
    page.getByRole("button", {
      name: "Walk, Tuesday, November 17, 2026",
      exact: true,
    }),
  ).toBeFocused();
  // Landing on the grid did not check anything either.
  await expect(
    page.getByRole("button", {
      name: "Walk, Tuesday, November 17, 2026",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("an archived habit keeps its link but leaves the agenda", async ({
  page,
}) => {
  await open(page, "/today", [["habit-2", "event-1"]]);
  await expect(
    page
      .getByRole("link", { name: "Morning walk" })
      .or(page.getByRole("button", { name: /Morning walk/ }))
      .first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /^Habit:/ })).toHaveCount(0);
});
