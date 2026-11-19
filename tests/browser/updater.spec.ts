import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

// U2-P7-04: the sidebar updater control and screen, against the IPC mock.
// window.__updateCheck sets what the mocked native check returns.

const calls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __calls?: Record<string, number> }).__calls?.[
        "check_for_update"
      ] ?? 0,
  );

test.beforeEach(async ({ page }) => {
  await installIpcMock(page);
});

test("startup and idle never check for updates", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1").first()).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await calls(page)).toBe(0);
  await page.goto("/updates");
  await expect(page.getByText(/checks only when you ask/)).toBeVisible();
  expect(await calls(page)).toBe(0);
});

test("the keyboard opens the updater, and Done returns focus", async ({
  page,
}) => {
  await page.goto("/settings");
  const button = page.getByRole("button", { name: "Check for updates" });
  await expect(button).toHaveAttribute("title", "Check for updates");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/updates$/);
  await expect(page.getByText("Unhollowed is up to date")).toBeVisible();
  expect(await calls(page)).toBe(1);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(button).toBeFocused();
});

test("an offline check recovers without trapping the person", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, {
      __updateCheck: {
        status: "failed",
        reason: "offline",
        detail: "connection refused",
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(
    page.getByText("Could not reach the update server"),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.assign(window, {
      __updateCheck: { status: "current", currentVersion: "1.0.0-beta.1" },
    }),
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Unhollowed is up to date")).toBeVisible();
  // The rest of the app stays reachable from the updater screen.
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Unhollowed 1.0.0-beta.1")).toBeVisible();
});

test("the control stays reachable in the narrow sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 700 });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Check for updates" });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box && box.x < 64).toBe(true);
});

for (const scheme of ["light", "dark"] as const) {
  test(`every updater state passes automated checks in ${scheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const results = [
      { status: "current", currentVersion: "1.0.0-beta.1" },
      {
        status: "available",
        currentVersion: "1.0.0-beta.1",
        version: "1.1.0-beta.1",
        date: null,
        notes: "Faster search",
      },
      { status: "failed", reason: "offline", detail: "x" },
      { status: "unsupported", target: "linux-x86_64" },
    ];
    const found: string[] = [];
    for (const result of results) {
      await page.addInitScript(
        (value) => Object.assign(window, { __updateCheck: value }),
        result,
      );
      await page.goto("/");
      await page.getByRole("button", { name: "Check for updates" }).click();
      await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      for (const violation of violations)
        found.push(`${result.status} ${violation.id}`);
    }
    expect(found).toEqual([]);
  });
}
