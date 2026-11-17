import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

// docs/HABITS.md fixture F2: synthetic data only.
const WALK = "fedcba9876543210fedcba9876543210";
const RETIRED = "00000000000000000000000000000001";
const READ = "0123456789abcdef0123456789abcdef";
const backup = {
  format: "ember-backup",
  version: 1,
  habits: [
    {
      id: WALK,
      name: "Synthetic walk",
      sortOrder: 0,
      startDate: "2028-01-01",
      archivedAt: null,
    },
    {
      id: RETIRED,
      name: "Synthetic retired",
      sortOrder: 1,
      startDate: "2027-12-01",
      archivedAt: "2028-01-15",
    },
    {
      id: READ,
      name: "Synthetic read",
      sortOrder: 2,
      startDate: "2028-02-01",
      archivedAt: null,
    },
  ],
  completions: [
    [RETIRED, "2028-01-10"],
    [READ, "2028-02-28"],
    [READ, "2028-02-29"],
  ],
};

async function open(page: Page, picked: object | null, habits: object[] = []) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript(
    ([file, seed]) => {
      Object.assign(window, {
        __pickedBackup: file,
        __seedHabits: { today: "2026-11-17", habits: seed },
      });
    },
    [picked, habits] as const,
  );
  await page.goto("/habits");
  await page.getByRole("button", { name: "Import from Ember" }).click();
  return page.getByRole("dialog", { name: "Import from Ember" });
}

const file = (content: unknown, name = "ember-backup.json") => ({
  name,
  content: typeof content === "string" ? content : JSON.stringify(content),
});

const stored = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as {
        __habits: {
          habits: {
            name: string;
            archivedOn: string | null;
            sourceId: string | null;
          }[];
          done: Set<string>;
        };
      }
    ).__habits;
    return { habits: state.habits, done: state.done.size };
  });

test("previews first, then imports archived habits, order, and history", async ({
  page,
}) => {
  const dialog = await open(page, file(backup), [{ name: "Existing" }]);
  await dialog.getByRole("button", { name: "Choose backup file…" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "ember-backup.json: 3 habits and 3 completed days will be added.",
  );
  const rows = dialog.getByRole("list", { name: "Imported habits" });
  await expect(rows.getByRole("listitem")).toHaveText([
    /Synthetic walk.*Starts Saturday, January 1, 2028, 0 completed days/,
    /Synthetic retired.*archived Saturday, January 15, 2028, 1 completed day/,
    /Synthetic read.*Starts Tuesday, February 1, 2028, 2 completed days/,
  ]);
  // The preview changed nothing.
  expect((await stored(page)).habits.map((habit) => habit.name)).toEqual([
    "Existing",
  ]);

  await dialog.getByRole("button", { name: "Import 3 habits" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Imported 3 habits and 3 completed days.",
  );
  const after = await stored(page);
  expect(after.habits.map((habit) => habit.name)).toEqual([
    "Existing",
    "Synthetic walk",
    "Synthetic retired",
    "Synthetic read",
  ]);
  expect(after.habits[2].archivedOn).toBe("2028-01-15");
  expect(after.habits[1].sourceId).toBe(WALK);
  expect(after.done).toBe(3);

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(
    page.getByRole("button", { name: "Import from Ember" }),
  ).toBeFocused();
});

test("cancelling the file dialog changes nothing", async ({ page }) => {
  const dialog = await open(page, null);
  await dialog.getByRole("button", { name: "Choose backup file…" }).click();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Choose backup file…" }),
  ).toBeEnabled();
});

const unsupported: [string, unknown, RegExp][] = [
  [
    "a newer Ember version",
    { ...backup, version: 2 },
    /newer Ember \(version 2\)/,
  ],
  [
    "a website snapshot",
    { encoding: "daily-bitmask-v1", schemaVersion: 1 },
    /website snapshot/,
  ],
  ["text that is not JSON", "not json", /not a JSON file/],
];
for (const [label, content, message] of unsupported) {
  test(`${label} is refused and nothing is written`, async ({ page }) => {
    const dialog = await open(page, file(content));
    await dialog.getByRole("button", { name: "Choose backup file…" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("ember-backup.json cannot be imported.");
    await expect(alert).toContainText(message);
    await expect(
      dialog.getByRole("button", { name: /^Import \d/ }),
    ).toHaveCount(0);
    expect((await stored(page)).habits).toHaveLength(0);
  });
}

test("same-name habits with other IDs are named and never merged", async ({
  page,
}) => {
  const dialog = await open(page, file(backup), [{ name: "synthetic WALK" }]);
  await dialog.getByRole("button", { name: "Choose backup file…" }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("never merged by name");
  await expect(
    alert.getByRole("list", { name: "Conflicting habits" }),
  ).toHaveText("Synthetic walk");
  expect((await stored(page)).habits).toHaveLength(1);
});

test("a repeat import is refused", async ({ page }) => {
  const dialog = await open(page, file(backup));
  await dialog.getByRole("button", { name: "Choose backup file…" }).click();
  await dialog.getByRole("button", { name: "Import 3 habits" }).click();
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Import from Ember" }).click();
  await dialog.getByRole("button", { name: "Choose backup file…" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Already imported from this backup: Synthetic walk, Synthetic retired, Synthetic read.",
  );
  expect((await stored(page)).habits).toHaveLength(3);
});

test("a preview that went stale is refused and can be reviewed again", async ({
  page,
}) => {
  const dialog = await open(page, file(backup));
  await dialog.getByRole("button", { name: "Choose backup file…" }).click();
  await expect(dialog.getByRole("status")).toContainText("will be added");
  // A habit is added elsewhere after the preview.
  await page.evaluate(() => {
    const state = (window as unknown as { __habits: { habits: object[] } })
      .__habits;
    state.habits.push({
      id: "habit-9",
      name: "Unrelated",
      position: 0,
      startDate: "2026-11-01",
      archivedOn: null,
      source: null,
      sourceId: null,
      revision: 0,
      createdAt: "",
      updatedAt: "",
    });
  });
  await dialog.getByRole("button", { name: "Import 3 habits" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "changed since the preview",
  );
  expect((await stored(page)).habits).toHaveLength(1);

  await dialog.getByRole("button", { name: "Review again" }).click();
  await dialog.getByRole("button", { name: "Import 3 habits" }).click();
  await expect(dialog.getByRole("status")).toContainText("Imported 3 habits");
  expect((await stored(page)).habits).toHaveLength(4);
});
