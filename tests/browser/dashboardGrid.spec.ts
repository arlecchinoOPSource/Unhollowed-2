import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

async function open(page: Page) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.goto("/dashboards");
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
}

const order = (page: Page) =>
  page
    .locator("[data-cell]")
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getAttribute("data-cell")),
    );

test("arranging by button: cancel keeps the layout, save keeps the new one across a restart", async ({
  page,
}) => {
  await open(page);
  expect(await order(page)).toEqual([
    "glance",
    "progress",
    "schedule",
    "habits",
    "mood",
  ]);

  await page.getByRole("button", { name: "Arrange widgets" }).click();
  await page.getByRole("button", { name: "Move up: Schedule" }).click();
  await expect(page.locator(".dash-arrange-note")).toContainText("Schedule:");
  expect(await order(page)).toEqual([
    "glance",
    "schedule",
    "progress",
    "habits",
    "mood",
  ]);
  await page.getByRole("button", { name: "Cancel" }).click();
  expect((await order(page))[1]).toBe("progress");

  await page.getByRole("button", { name: "Arrange widgets" }).click();
  await page.getByRole("button", { name: "Move up: Schedule" }).click();
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(
    page.getByRole("button", { name: "Arrange widgets" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
  expect((await order(page))[1]).toBe("schedule");
});

test("the keyboard moves and resizes a focused widget", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Arrange widgets" }).click();
  const frame = page.getByRole("group", { name: "Arrange Habits" });
  await frame.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(page.locator(".dash-arrange-note")).toContainText(
    "10 columns wide",
  );
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".dash-arrange-note")).toContainText("Habits:");
  // Arrow keys on the buttons inside do not move the widget.
  await page.getByRole("button", { name: "Wider: Habits" }).press("ArrowDown");
  await expect(page.locator(".dash-arrange-note")).toContainText(
    "10 columns wide",
  );
});

test("two half-width widgets can share a row", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Arrange widgets" }).click();
  const press = async (name: string, times: number) => {
    for (let i = 0; i < times; i++)
      await page.getByRole("button", { name }).click();
  };
  await press("Narrower: Schedule", 6);
  await press("Narrower: Habits", 6);
  await press("Move right: Habits", 6);
  await press("Move up: Habits", 4);
  await expect(page.locator(".dash-arrange-note")).toContainText(
    "column 7, row 8, 6 columns wide",
  );
  const [schedule, habits] = await Promise.all([
    page.locator('[data-cell="schedule"]').boundingBox(),
    page.locator('[data-cell="habits"]').boundingBox(),
  ]);
  expect(Math.abs(schedule!.y - habits!.y)).toBeLessThan(2);
  expect(habits!.x).toBeGreaterThan(schedule!.x + schedule!.width - 2);
});

test("a failed save keeps the last committed layout and says so", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Arrange widgets" }).click();
  await page.getByRole("button", { name: "Move up: Schedule" }).click();
  await page.evaluate(() => Object.assign(window, { __failDashboards: true }));
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not read or save");
  // Still arranging; Cancel returns to the committed order.
  await page.getByRole("button", { name: "Cancel" }).click();
  expect((await order(page))[1]).toBe("progress");
});

test("narrow windows show one column in reading order", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await open(page);
  const boxes = await page.locator("[data-cell]").evaluateAll((cells) =>
    cells.map((cell) => {
      const box = cell.getBoundingClientRect();
      return [Math.round(box.left), Math.round(box.top)];
    }),
  );
  expect(new Set(boxes.map(([left]) => left)).size).toBe(1);
  const tops = boxes.map(([, top]) => top);
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
});
