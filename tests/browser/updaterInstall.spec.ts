import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

// U2-P7-06: installation handoff and the first start after the restart.
const RESUME = "unhollowed-2-update-resume";

async function offerUpdate(page: Page, installPlan: object) {
  await page.addInitScript(
    (plan) =>
      Object.assign(window, {
        __updateCheck: {
          status: "available",
          currentVersion: "1.0.0-beta.1",
          version: "1.1.0-beta.1",
          date: null,
          notes: null,
        },
        __downloadPlan: { events: [{ event: "finished" }] },
        __installPlan: plan,
      }),
    installPlan,
  );
}

test.beforeEach(async ({ page }) => {
  await installIpcMock(page);
});

test("installing records where to return and hands over to restart", async ({
  page,
}) => {
  await offerUpdate(page, { installed: true });
  await page.goto("/issues");
  await page.getByRole("button", { name: "Check for updates" }).click();
  await page.getByRole("button", { name: "Download and install" }).click();
  await expect(page.locator(".updates-title")).toHaveText(
    "Restarting Unhollowed...",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), RESUME)).toBe(
    JSON.stringify({ version: "1.1.0-beta.1", path: "/issues" }),
  );
});

test("a failed installation keeps the app open and forgets the handoff", async ({
  page,
}) => {
  await offerUpdate(page, {
    result: { status: "failed", reason: "database", detail: "busy" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Check for updates" }).click();
  await page.getByRole("button", { name: "Download and install" }).click();
  await expect(
    page.getByText("The update could not be installed"),
  ).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), RESUME),
  ).toBeNull();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("h1").first()).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`after restart the installed version is confirmed in ${scheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.addInitScript((key) => {
      // Only on the first load, as the record is consumed.
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem(
          key,
          JSON.stringify({ version: "1.1.0-beta.1", path: "/settings" }),
        );
      }
      Object.assign(window, { __appVersion: "1.1.0-beta.1" });
    }, RESUME);
    await page.goto("/");
    await expect(page.getByText("Unhollowed is up to date.")).toBeVisible();
    await expect(
      page.getByText(/Version 1\.1\.0-beta\.1 is installed/),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByText("Unhollowed 1.1.0-beta.1")).toBeVisible();
    // No network request is involved in confirming the update.
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __calls?: Record<string, number> }).__calls
            ?.check_for_update ?? 0,
      ),
    ).toBe(0);
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(violations.map((violation) => violation.id)).toEqual([]);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("Unhollowed is up to date.")).toBeHidden();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Unhollowed is up to date.")).toBeHidden();
  });
}

test("a version that did not change is reported as an unfinished update", async ({
  page,
}) => {
  await page.addInitScript(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({ version: "1.1.0-beta.1", path: "/settings" }),
      ),
    RESUME,
  );
  await page.goto("/");
  await expect(
    page.getByText("The update to 1.1.0-beta.1 did not finish."),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
