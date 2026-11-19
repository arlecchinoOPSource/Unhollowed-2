import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

// U2-P7-05: the butterfly, the ellipsis, and byte-driven download progress.
const offer = {
  status: "available",
  currentVersion: "1.0.0-beta.1",
  version: "1.1.0-beta.1",
  date: null,
  notes: null,
};

async function plan(page: Page, downloadPlan: object) {
  await page.addInitScript(
    ([check, download]) =>
      Object.assign(window, {
        __updateCheck: check,
        __downloadPlan: download,
      }),
    [offer, downloadPlan] as const,
  );
}

async function startDownload(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Check for updates" }).click();
  await page.getByRole("button", { name: "Download and install" }).click();
}

/** Running animations on the updater screen's butterfly, dots, and bar. */
const running = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          (animation as CSSAnimation).animationName?.startsWith("updates-"),
      )
      .map((animation) => (animation as CSSAnimation).animationName)
      .sort(),
  );

test.beforeEach(async ({ page }) => {
  await installIpcMock(page);
});

test("checking shows the breathing butterfly and sequential dots", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await dispatch(page, "hold-command", "check_for_update");
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.locator(".updates-title")).toHaveText("Checking...");
  await expect(page.locator(".updates-mark svg")).toBeVisible();
  const names = await running(page);
  expect(names).toContain("updates-breathe");
  expect(names.filter((name) => name === "updates-dot")).toHaveLength(3);
  await dispatch(page, "release-check_for_update");
  await expect(page.getByText("Unhollowed is up to date")).toBeVisible();
  // A settled state runs nothing, so an idle screen costs no rendering.
  await page.waitForTimeout(400);
  expect(await running(page)).toEqual([]);
});

test("reduced motion shows a still butterfly and readable states", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await plan(page, {
    events: [{ event: "progress", downloaded: 1048576, total: null }],
    hold: true,
  });
  await startDownload(page);
  await expect(page.locator(".updates-title")).toHaveText(
    "Downloading update...",
  );
  expect(await running(page)).toEqual([]);
  await expect(page.locator(".updates-ellipsis span").first()).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(page.getByText("1 MB downloaded")).toBeVisible();
  await dispatch(page, "release-download");
});

test("download progress follows the reported bytes", async ({ page }) => {
  await plan(page, {
    events: [{ event: "progress", downloaded: 3145728, total: 4194304 }],
    hold: true,
  });
  await startDownload(page);
  const bar = page.getByRole("progressbar", { name: "Download progress" });
  await expect(bar).toHaveAttribute("aria-valuenow", "75");
  await expect(page.getByText("75% · 3 MB of 4 MB")).toBeVisible();
  await dispatch(page, "release-download");
  await expect(
    page.getByText("The update could not be installed"),
  ).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`progress states pass automated checks in ${scheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const found: string[] = [];
    const scan = async (label: string) => {
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      for (const violation of violations)
        found.push(`${label} ${violation.id}`);
    };
    await plan(page, {
      events: [{ event: "progress", downloaded: 1024, total: 4096 }],
      hold: true,
    });
    await startDownload(page);
    await expect(page.getByRole("progressbar")).toBeVisible();
    await scan("known total");
    await dispatch(page, "release-download");
    await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
    await scan("after download");
    expect(found).toEqual([]);
  });
}
