import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

// The Phase 4 workflow in one pass, in both themes: add and check a habit,
// record a partial check-in, see the dashboard ask for fresh numbers, come
// back to the same records, and keep the dashboard period across a reload.
// The IPC is mocked, so it checks the UI and its requests. The totals and
// persistence across restart are covered by `src-tauri/src/phase4_journey.rs`.
test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const calls = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __calls: Record<string, number> }).__calls[
        name
      ] ?? 0,
    command,
  );

const nav = (page: Page, name: string) =>
  page.getByRole("navigation").getByRole("link", { name, exact: true });

for (const scheme of ["light", "dark"] as const) {
  test(`habits, mood, and dashboard work together in ${scheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await installIpcMock(page);
    await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
    await page.addInitScript(() =>
      Object.assign(window, {
        __seedHabits: {
          today: "2026-11-17",
          habits: [{ name: "Walk", startDate: "2026-11-10" }],
        },
      }),
    );

    // Add a habit and check today.
    await page.goto("/habits");
    const form = page.getByRole("form", { name: "Add a habit" });
    await form.getByLabel("New habit").fill("Stretch");
    await form.getByRole("button", { name: "Add habit" }).click();
    const walk = page.getByRole("button", {
      name: "Walk, Tuesday, November 17, 2026",
      exact: true,
    });
    await walk.click();
    await expect(walk).toHaveAttribute("aria-pressed", "true");

    // A partial check-in leaves the other ratings unset.
    await nav(page, "Mood").click();
    await page
      .getByRole("group", { name: /^Mood/ })
      .getByRole("radio", { name: "4", exact: true })
      .check();
    await page.getByRole("button", { name: "Save check-in" }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Saved your check-in for Tuesday, November 17, 2026.",
    );

    // The dashboard asks for fresh numbers each time it opens.
    await nav(page, "Dashboards").click();
    await expect(
      page.getByRole("heading", { name: "At a glance" }),
    ).toBeVisible();
    const first = await calls(page, "get_habit_statistics");
    expect(first).toBeGreaterThan(0);
    await page
      .getByRole("button", { name: "Last 7 days", exact: true })
      .click();

    // Back to the habits: both habits and the check are still there.
    await nav(page, "Habits").click();
    await expect(walk).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", {
        name: "Stretch, Tuesday, November 17, 2026",
        exact: true,
      }),
    ).toBeVisible();
    await nav(page, "Dashboards").click();
    await expect(
      page.getByRole("heading", { name: "At a glance" }),
    ).toBeVisible();
    expect(await calls(page, "get_habit_statistics")).toBeGreaterThan(first);

    // The period is a preference, so it survives a reload.
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Last 7 days", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });
}
