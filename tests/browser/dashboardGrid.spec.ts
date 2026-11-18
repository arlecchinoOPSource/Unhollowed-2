import AxeBuilder from "@axe-core/playwright";
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

/** Opens the manage menu if needed, then starts arranging. */
async function arrange(page: Page) {
  const menu = page.locator(".dash-manager details");
  if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open)))
    await menu.locator("summary").click();
  await page.getByRole("button", { name: "Arrange widgets" }).click();
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

  await arrange(page);
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

  await arrange(page);
  await page.getByRole("button", { name: "Move up: Schedule" }).click();
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("button", { name: "Add widget" })).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
  expect((await order(page))[1]).toBe("schedule");
});

test("the keyboard moves and resizes a focused widget", async ({ page }) => {
  await open(page);
  await arrange(page);
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
  await arrange(page);
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
  await arrange(page);
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

test("add a note from the library, configure it, and keep it across a restart", async ({
  page,
}) => {
  await open(page);
  await arrange(page);
  const add = page.getByRole("button", { name: "Add widget" });
  await add.click();
  const library = page.getByRole("dialog", { name: "Add a widget" });
  await expect(library.getByText("Not available yet:")).toContainText(
    "Issue list",
  );
  // Previews use the real widget.
  await library.getByRole("button", { name: "Preview Notes" }).click();
  await expect(library.locator('[data-preview="notes"]')).toContainText(
    "Empty note",
  );
  await library.getByRole("button", { name: "Add Notes" }).click();
  await expect(library).toHaveCount(0);
  await expect(add).toBeFocused();

  const settings = page.getByRole("button", { name: "Settings: Notes" });
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "Settings: Notes" });
  await dialog.getByLabel("Note").fill("Remember the review");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(settings).toBeFocused();
  await expect(page.locator('[data-cell="notes-1"]')).toContainText(
    "Remember the review",
  );
  await page.getByRole("button", { name: "Save layout" }).click();
  await page.reload();
  await expect(page.locator('[data-cell="notes-1"]')).toContainText(
    "Remember the review",
  );
});

test("settings that would not survive a restart cannot be applied; reset restores defaults", async ({
  page,
}) => {
  await open(page);
  await arrange(page);
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: "Add Notes" }).click();
  await page.getByRole("button", { name: "Settings: Notes" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings: Notes" });
  await dialog.getByLabel("Note").fill("x".repeat(2001));
  await expect(dialog.getByRole("alert")).toContainText("not valid");
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(dialog.getByLabel("Note")).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("shortcuts are chosen from places in the app; widgets can be removed", async ({
  page,
}) => {
  await open(page);
  await arrange(page);
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: "Add Shortcuts" }).click();
  await page.getByRole("button", { name: "Settings: Shortcuts" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings: Shortcuts" });
  await dialog.getByLabel("Habits").check();
  await dialog.getByLabel("Calendar").check();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.locator('[data-cell="shortcuts-1"]').getByRole("link", {
      name: "Habits",
    }),
  ).toHaveAttribute("href", "/habits");

  await page
    .getByRole("button", { name: "Remove: Mood, energy, and focus" })
    .click();
  await expect(page.locator('[data-cell="mood"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator('[data-cell="mood"]')).toHaveCount(1);
  await expect(page.locator('[data-cell="shortcuts-1"]')).toHaveCount(0);
});

test("arrange mode and its dialogs pass automated accessibility checks", async ({
  page,
}) => {
  await open(page);
  await arrange(page);
  const check = async () => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  };
  await check();
  await page.getByRole("button", { name: "Add widget" }).click();
  await check();
  await page.getByRole("button", { name: "Add Notes" }).click();
  await page.getByRole("button", { name: "Settings: Notes" }).click();
  await check();
});

const manage = async (page: Page) => {
  const menu = page.locator(".dash-manager details");
  if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open)))
    await menu.locator("summary").click();
};

test("named dashboards: create from a template, rename, duplicate, default, and delete with confirmation", async ({
  page,
}) => {
  await open(page);
  const picker = page.getByRole("combobox", { name: "Dashboard", exact: true });
  await expect(picker.locator("option")).toHaveText(["Dashboard (default)"]);

  // New from a template.
  await manage(page);
  await page.getByRole("button", { name: "New dashboard" }).click();
  const create = page.getByRole("dialog", { name: "New dashboard" });
  await create.getByLabel("Name").fill("School");
  await create.getByLabel(/Student Workspace/).check();
  await create.getByRole("button", { name: "Create" }).click();
  await expect(picker).toHaveValue(/dashboard-/);
  await expect(picker.locator("option:checked")).toHaveText("School");
  await expect(page.locator('[data-cell^="notes-"]')).toHaveCount(1);
  await expect(page.locator('[data-cell="glance"]')).toHaveCount(0);

  // Names are unique.
  await page.getByRole("button", { name: "New dashboard" }).click();
  const again = page.getByRole("dialog", { name: "New dashboard" });
  await again.getByLabel("Name").fill("school");
  await again.getByRole("button", { name: "Create" }).click();
  await expect(again.getByRole("alert")).toContainText("already has this name");
  await again.getByRole("button", { name: "Cancel" }).click();

  // Rename and duplicate.
  await page.getByRole("button", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename dashboard" });
  await rename.getByLabel("Name").fill("Semester");
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(picker.locator("option:checked")).toHaveText("Semester");
  await page.getByRole("button", { name: "Duplicate" }).click();
  const copy = page.getByRole("dialog", { name: "Duplicate dashboard" });
  await expect(copy.getByLabel("Name")).toHaveValue("Semester copy");
  await copy.getByRole("button", { name: "Create" }).click();
  await expect(picker.locator("option:checked")).toHaveText("Semester copy");

  // Make the copy the default; it survives a restart.
  await page.getByRole("button", { name: "Make default" }).click();
  await expect(picker.locator("option:checked")).toHaveText(
    "Semester copy (default)",
  );
  await page.reload();
  await expect(picker.locator("option:checked")).toHaveText(
    "Semester copy (default)",
  );
  await expect(picker.locator("option")).toHaveCount(3);

  // Deleting asks first and says what is lost.
  await manage(page);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete dashboard?" });
  await expect(confirm).toContainText("cannot be undone");
  await expect(confirm).toContainText("default");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(picker.locator("option")).toHaveCount(3);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete dashboard" }).click();
  await expect(picker.locator("option")).toHaveCount(2);
  // The next dashboard became the default and opened.
  await expect(picker.locator("option").first()).toContainText("(default)");
});

test("deleting the only dashboard leaves a usable General Productivity one", async ({
  page,
}) => {
  await open(page);
  await manage(page);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("only dashboard");
  await page.getByRole("button", { name: "Delete dashboard" }).click();
  await expect(
    page
      .getByRole("combobox", { name: "Dashboard", exact: true })
      .locator("option"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
});

test("reset layout asks first and restores the starter widgets", async ({
  page,
}) => {
  await open(page);
  await arrange(page);
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: "Add Notes" }).click();
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.locator('[data-cell="notes-1"]')).toHaveCount(1);
  await manage(page);
  await page.getByRole("button", { name: "Reset layout" }).click();
  const confirm = page.getByRole("dialog", { name: "Reset layout?" });
  await expect(confirm).toContainText("lost");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator('[data-cell="notes-1"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Reset layout" }).click();
  await page.getByRole("button", { name: "Reset layout" }).last().click();
  await expect(page.locator('[data-cell="notes-1"]')).toHaveCount(0);
  await expect(page.locator("[data-cell]")).toHaveCount(5);
});

test("the dashboard manager and its confirmations pass automated accessibility checks", async ({
  page,
}) => {
  await open(page);
  const check = async () => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  };
  await manage(page);
  await check();
  await page.getByRole("button", { name: "New dashboard" }).click();
  await check();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await check();
});

test("charts from the library read the shared queries and pass accessibility checks", async ({
  page,
}) => {
  await open(page);
  await arrange(page);
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: "Add Bar chart" }).click();
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: "Add Line chart" }).click();
  await page.getByRole("button", { name: "Settings: Line chart" }).click();
  const dialog = page.getByRole("dialog", { name: /Settings: Line chart/ });
  await dialog.getByLabel("Measure").selectOption("habit-completion");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("button", { name: "Save layout" }).click();

  const bar = page.locator('[data-cell="bar-chart-1"]');
  await expect(
    bar.getByRole("heading", { name: "Issues completed" }),
  ).toBeVisible();
  // The seeded workspace completed nothing, so this is the empty state.
  await expect(bar.locator('[data-chart-state="empty"]')).toContainText(
    "No issues were completed in this period.",
  );

  const line = page.locator('[data-cell="line-chart-1"]');
  await expect(
    line.getByRole("heading", { name: "Habit completion" }),
  ).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(
      (value) => (document.documentElement.dataset.theme = value),
      theme,
    );
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(violations.map((v) => `${theme} ${v.id}: ${v.help}`)).toEqual([]);
  }
});

test("habit charts say they do not apply under a project filter", async ({
  page,
}) => {
  await open(page);
  await arrange(page);
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: "Add Line chart" }).click();
  await page.getByRole("button", { name: "Settings: Line chart" }).click();
  await page
    .getByRole("dialog", { name: /Settings: Line chart/ })
    .getByLabel("Measure")
    .selectOption("habit-completion");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("button", { name: "Save layout" }).click();
  await page
    .locator(".dash-controls select")
    .first()
    .selectOption({ index: 1 });
  await expect(
    page.locator('[data-cell="line-chart-1"] [data-chart-state="unavailable"]'),
  ).toContainText("not part of a project");
});
