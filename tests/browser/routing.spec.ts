import { expect, test } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

test.beforeEach(async ({ page }) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-16T10:00:00+01:00"));
});

test("an event link opens the event over its day and is dropped from the URL", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, {
      __seedEvents: [
        {
          title: "Planning",
          startLocal: "2026-11-18T09:00",
          endLocal: "2026-11-18T10:00",
        },
      ],
    }),
  );
  await page.goto("/calendar?view=day&date=2026-11-18&event=event-1");
  const editor = page.getByRole("dialog", { name: "Edit event" });
  await expect(editor.getByLabel("Title")).toHaveValue("Planning");
  await expect(page).not.toHaveURL(/event=/);
  await expect(page).toHaveURL(/date=2026-11-18/);
});

test("a missing event still shows the day with a plain explanation", async ({
  page,
}) => {
  await page.goto("/calendar?view=day&date=2026-11-18&event=gone");
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/date=2026-11-18/);
});

test("a malformed event ID is ignored", async ({ page }) => {
  await page.goto("/calendar?view=day&date=2026-11-18&event=..%2Fx");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("malformed issue, project, and document links explain themselves", async ({
  page,
}) => {
  await page.goto("/issues/a%20b");
  await expect(
    page.getByRole("heading", { name: "Issue unavailable" }),
  ).toBeVisible();
  await page.goto("/projects/a%20b");
  await expect(page.getByRole("alert")).toContainText(
    "does not name a project",
  );
  await page.goto("/documents?doc=a%2Fb");
  await expect(page.getByRole("alert")).toContainText(
    "does not name a document",
  );
});
