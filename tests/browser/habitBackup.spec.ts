import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

const seed = {
  today: "2026-11-17",
  habits: [
    { name: "Walk", startDate: "2026-11-05" },
    { name: "Read", startDate: "2026-11-01", archivedOn: "2026-11-12" },
    { name: "Empty", startDate: "2026-11-10" },
  ],
  completions: [
    ["habit-1", "2026-11-10"],
    ["habit-2", "2026-11-12"],
  ],
};

async function open(page: Page) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((value) => {
    Object.assign(window, { __seedHabits: value });
  }, seed);
  await page.goto("/habits");
  await page.getByRole("button", { name: "Backup and restore" }).click();
  return page.getByRole("dialog", { name: "Backup and restore" });
}

type Win = {
  __habits: {
    habits: { id: string; name: string; archivedOn: string | null }[];
    done: Set<string>;
  };
  __saved?: { kind: string; content: string };
  __pickedRestore?: { name: string; content: string } | null;
  __saveCancelled?: boolean;
  __failCopy?: boolean;
};

const names = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as Win).__habits.habits.map((habit) => habit.name),
  );

/** Saves a backup, then removes Empty and adds Newer, as later edits. */
async function backupThenEdit(page: Page, dialog: ReturnType<Page["locator"]>) {
  await dialog.getByRole("button", { name: "Save backup…" }).click();
  await expect(dialog.getByRole("status")).toContainText("Saved a backup");
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__habits.habits = w.__habits.habits.filter((h) => h.name !== "Empty");
    w.__habits.habits.push({
      id: "habit-9",
      name: "Newer",
      archivedOn: null,
      position: 9,
      startDate: "2026-11-01",
      source: null,
      sourceId: null,
      revision: 0,
    } as never);
    w.__pickedRestore = {
      name: "habits.json",
      content: w.__saved!.content,
    };
  });
}

test("saves a backup and both history exports, or reports a canceled save", async ({
  page,
}) => {
  const dialog = await open(page);
  const status = dialog.getByRole("status");
  await dialog.getByRole("button", { name: "Save backup…" }).click();
  await expect(status).toHaveText(
    "Saved a backup of habits with 2 completed days to /Documents/unhollowed-habits.json.",
  );
  await dialog.getByRole("button", { name: "Export history as CSV…" }).click();
  await expect(status).toContainText("Saved CSV history");
  await expect(status).toContainText(".csv.");
  await dialog.getByRole("button", { name: "Export history as JSON…" }).click();
  await expect(status).toContainText("Saved JSON history");

  await page.evaluate(() => {
    (window as unknown as Win).__saveCancelled = true;
  });
  await dialog.getByRole("button", { name: "Save backup…" }).click();
  await expect(status).toHaveText("Export canceled.");
});

test("a restore previews, replaces habits and order, and can be undone and redone", async ({
  page,
}) => {
  const dialog = await open(page);
  await backupThenEdit(page, dialog);
  expect(await names(page)).toEqual(["Walk", "Read", "Newer"]);

  await dialog.getByRole("button", { name: "Restore from backup…" }).click();
  await expect(
    dialog.getByRole("heading", { name: /^habits\.json has 3 habits/ }),
  ).toHaveText(
    "habits.json has 3 habits (1 archived) and 2 completed days. Restoring replaces your 3 habits and 2 completed days.",
  );
  // The preview changed nothing.
  expect(await names(page)).toEqual(["Walk", "Read", "Newer"]);

  await dialog.getByRole("button", { name: "Replace my habits" }).click();
  await expect(
    dialog.getByRole("heading", { name: /^Restored 3 habits/ }),
  ).toHaveText("Restored 3 habits (1 archived) and 2 completed days.");
  await expect(dialog).toContainText(
    "saved privately as habits-pre-restore-1.json",
  );
  // Empty habits and archive state come back, in order, with their history.
  expect(await names(page)).toEqual(["Walk", "Read", "Empty"]);
  const kept = await page.evaluate(() => {
    const w = window as unknown as Win;
    return {
      archived: w.__habits.habits.find((h) => h.name === "Read")!.archivedOn,
      done: w.__habits.done.size,
    };
  });
  expect(kept).toEqual({ archived: "2026-11-12", done: 2 });

  await dialog.getByRole("button", { name: "Undo restore" }).click();
  await expect(
    dialog.getByRole("heading", { name: /^Restore undone/ }),
  ).toBeVisible();
  expect(await names(page)).toEqual(["Walk", "Read", "Newer"]);

  await dialog.getByRole("button", { name: "Redo restore" }).click();
  expect(await names(page)).toEqual(["Walk", "Read", "Empty"]);
});

test("an unsupported file is refused and nothing changes", async ({ page }) => {
  const dialog = await open(page);
  await page.evaluate(() => {
    (window as unknown as Win).__pickedRestore = {
      name: "future.json",
      content: JSON.stringify({
        format: "unhollowed-2/habits",
        version: 2,
        habits: [],
        completions: [],
      }),
    };
  });
  await dialog.getByRole("button", { name: "Restore from backup…" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "future.json cannot be restored. This backup was made by a newer version",
  );
  await expect(
    dialog.getByRole("button", { name: "Replace my habits" }),
  ).toHaveCount(0);
  expect(await names(page)).toEqual(["Walk", "Read", "Empty"]);
});

test("cancelling the file dialog changes nothing", async ({ page }) => {
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "Restore from backup…" }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("heading", { level: 4 })).toHaveCount(0);
});

test("a stale preview is refused and can be reviewed again", async ({
  page,
}) => {
  const dialog = await open(page);
  await backupThenEdit(page, dialog);
  await dialog.getByRole("button", { name: "Restore from backup…" }).click();
  await expect(
    dialog.getByRole("button", { name: "Replace my habits" }),
  ).toBeVisible();
  // A completion lands after the preview.
  await page.evaluate(() => {
    const w = window as unknown as Win & {
      __habits: { habits: { revision: number }[] };
    };
    w.__habits.habits[0].revision += 1;
  });
  await dialog.getByRole("button", { name: "Replace my habits" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "changed since the preview",
  );
  expect(await names(page)).toEqual(["Walk", "Read", "Newer"]);

  await dialog.getByRole("button", { name: "Review again" }).click();
  await dialog.getByRole("button", { name: "Replace my habits" }).click();
  await expect(
    dialog.getByRole("heading", { name: /^Restored/ }),
  ).toBeVisible();
  expect(await names(page)).toEqual(["Walk", "Read", "Empty"]);
});

test("nothing is replaced when the private copy cannot be saved", async ({
  page,
}) => {
  const dialog = await open(page);
  await backupThenEdit(page, dialog);
  await dialog.getByRole("button", { name: "Restore from backup…" }).click();
  await page.evaluate(() => {
    (window as unknown as Win).__failCopy = true;
  });
  await dialog.getByRole("button", { name: "Replace my habits" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "A private copy of your current habits could not be saved, so nothing was replaced.",
  );
  expect(await names(page)).toEqual(["Walk", "Read", "Newer"]);
  // Still under review: once copies work again the restore goes through.
  await page.evaluate(() => {
    (window as unknown as Win).__failCopy = false;
  });
  await dialog.getByRole("button", { name: "Replace my habits" }).click();
  await expect(
    dialog.getByRole("heading", { name: /^Restored/ }),
  ).toBeVisible();
});
