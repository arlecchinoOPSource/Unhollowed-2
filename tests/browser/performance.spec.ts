import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Issue } from "../../src/database/issues";
import { installIpcMock } from "./ipcMock";

// Rendering timings with an in-memory backend, so they measure the UI only.
// Opt-in, because wall-clock numbers vary by machine:
// `PERF=1 npx playwright test performance --reporter=line`.
// docs/PERFORMANCE.md records the results.
test.skip(!process.env.PERF, "Set PERF=1 to run the timing fixture.");

const STATUSES = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "canceled",
] as const;

function issues(count: number): Partial<Issue>[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Issue ${index + 1} about launch plans`,
    status: STATUSES[index % STATUSES.length],
    closed: index % 5 >= 3,
    projectId: index % 3 === 0 ? null : "project-1",
    dueDate:
      index % 4 === 0
        ? null
        : `2026-${String(10 + (index % 3)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`,
  }));
}

/** Milliseconds from starting `action` until `ready` is visible, and the
 * main-thread long tasks (over 50 ms) in that span. */
async function time(
  page: Page,
  action: () => Promise<unknown>,
  ready: Locator,
  /** Dense clusters can squeeze items to nothing, so views may only need to
   * have rendered them. */
  state: "visible" | "attached" = "visible",
): Promise<[number, number]> {
  await page.evaluate(() => {
    (window as unknown as { __long: number }).__long = 0;
  });
  const start = Date.now();
  await action();
  if (state === "visible") await expect(ready).toBeVisible({ timeout: 30_000 });
  else await ready.waitFor({ state, timeout: 30_000 });
  const elapsed = Date.now() - start;
  const long = await page.evaluate(
    () => (window as unknown as { __long: number }).__long,
  );
  return [elapsed, long];
}

for (const count of [500, 2000]) {
  test(`renders the main pages with ${count} issues`, async ({ page }) => {
    test.setTimeout(180_000);
    await installIpcMock(page);
    await page.addInitScript((data) => {
      Object.assign(window, { __seedIssues: data });
      const long = window as unknown as { __long: number };
      long.__long = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) long.__long += entry.duration;
      }).observe({ type: "longtask", buffered: true });
    }, issues(count));
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00"));
    const nav = page.getByRole("navigation", { name: "Workspace" });
    const rows: string[] = [];
    const record = async (
      name: string,
      action: () => Promise<unknown>,
      ready: Locator,
      setup?: () => Promise<unknown>,
    ) => {
      const samples: [number, number][] = [];
      for (let run = 0; run < 3; run += 1) {
        await page.goto("/");
        await expect(nav).toBeVisible();
        await setup?.();
        samples.push(await time(page, action, ready));
      }
      samples.sort((a, b) => a[0] - b[0]);
      const [ms, long] = samples[1];
      rows.push(`| ${name} | ${ms} ms | ${Math.round(long)} ms |`);
    };

    await record(
      "Issues list",
      () => nav.getByRole("link", { name: "Issues" }).click(),
      page.getByRole("list", { name: "Open issues" }).getByRole("link").first(),
    );
    await record(
      "Board",
      async () => {
        await nav.getByRole("link", { name: "Issues" }).click();
        await page.getByRole("link", { name: "Board view" }).click();
      },
      page
        .getByRole("region", { name: /^Blocked/ })
        .getByRole("link")
        .first(),
    );
    await record(
      "Today",
      () => nav.getByRole("link", { name: "Today" }).click(),
      page
        .getByRole("link", { name: /^Issue \d+ about launch plans$/ })
        .first(),
    );
    await record(
      "Calendar",
      () => page.goto("/calendar?view=month"),
      page.getByRole("link", { name: /Issue \d+ about launch plans/ }).first(),
    );
    await record(
      "Project overview",
      async () => {
        await nav.getByRole("link", { name: "Projects" }).click();
        await page.getByRole("link", { name: /Studio launch/ }).click();
      },
      page.getByRole("heading", { name: "Issues by status" }),
    );
    await record(
      "Relationship picker",
      () => page.getByRole("button", { name: "Add relationship" }).click(),
      page
        .getByRole("combobox", { name: "Issue" })
        .and(page.locator(":enabled")),
      async () => {
        await page.goto("/issues/seed-2");
        await expect(
          page.getByRole("button", { name: "Add relationship" }),
        ).toBeVisible();
      },
    );
    console.log(
      `\n${count} issues\n| Page | Time to content | Long tasks |\n|---|---:|---:|\n${rows.join("\n")}`,
    );
  });
}

/** Timed events across November 2026, in clusters so the views overlap. */
function events(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const day = String(1 + (index % 28)).padStart(2, "0");
    const hour = String(8 + (index % 9)).padStart(2, "0");
    return {
      title: `Meeting ${index + 1} about launch plans`,
      startLocal: `2026-11-${day}T${hour}:00`,
      endLocal: `2026-11-${day}T${hour}:45`,
      timeZone: "UTC",
    };
  });
}

for (const count of [500, 2000]) {
  test(`renders the calendar views with ${count} events`, async ({ page }) => {
    test.setTimeout(180_000);
    await installIpcMock(page);
    await page.addInitScript((data) => {
      Object.assign(window, { __seedEvents: data });
      const long = window as unknown as { __long: number };
      long.__long = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) long.__long += entry.duration;
      }).observe({ type: "longtask", buffered: true });
    }, events(count));
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00Z"));
    const rows: string[] = [];
    for (const [name, url, ready] of [
      ["Day", "/calendar?view=day&date=2026-11-18", /Meeting \d+ about/],
      ["Week", "/calendar?view=week&date=2026-11-18", /Meeting \d+ about/],
      ["Month", "/calendar?view=month&month=2026-11", /Meeting \d+ about/],
      ["Agenda", "/calendar?view=agenda&month=2026-11", /Meeting \d+ about/],
    ] as const) {
      const samples: [number, number][] = [];
      for (let run = 0; run < 3; run += 1) {
        await page.goto("/");
        await expect(page.locator("h1").first()).toBeVisible();
        samples.push(
          await time(
            page,
            () => page.goto(url),
            page.getByText(ready).first(),
            "attached",
          ),
        );
      }
      samples.sort((a, b) => a[0] - b[0]);
      rows.push(
        `| ${name} | ${samples[1][0]} ms | ${Math.round(samples[1][1])} ms |`,
      );
    }
    console.log(
      `\n${count} events\n| View | Time to content | Long tasks |\n|---|---:|---:|\n${rows.join("\n")}`,
    );
  });
}

/** 30 habits (five archived) with checks on about seven days in ten over
 * five years: the month grid draws 30 columns by 30 rows. */
function habitFixture() {
  const habits = Array.from({ length: 30 }, (_, index) => ({
    name: `Habit ${index + 1}`,
    startDate: "2021-11-16",
    archivedOn: index % 6 === 5 ? "2026-10-31" : null,
  }));
  const completions: [string, string][] = [];
  const start = Date.UTC(2021, 10, 16);
  for (let day = 0; day <= 1826; day += 1) {
    const date = new Date(start + day * 86_400_000).toISOString().slice(0, 10);
    if (date > "2026-11-16") break;
    habits.forEach((habit, index) => {
      if (habit.archivedOn && date > habit.archivedOn) return;
      if ((day * 7 + index * 3) % 10 < 7)
        completions.push([`habit-${index + 1}`, date]);
    });
  }
  return { today: "2026-11-16", habits, completions };
}

test("renders habit tracking with 30 habits and five years of history", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await installIpcMock(page);
  const fixture = habitFixture();
  await page.addInitScript((data) => {
    Object.assign(window, { __seedHabits: data });
    const long = window as unknown as { __long: number };
    long.__long = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) long.__long += entry.duration;
    }).observe({ type: "longtask", buffered: true });
  }, fixture);
  await page.clock.setFixedTime(new Date("2026-11-16T10:00:00Z"));
  const rows: string[] = [];
  const measure = async (
    name: string,
    run: () => Promise<[number, number]>,
  ) => {
    const samples: [number, number][] = [];
    for (let i = 0; i < 3; i += 1) samples.push(await run());
    samples.sort((a, b) => a[0] - b[0]);
    rows.push(
      `| ${name} | ${samples[1][0]} ms | ${Math.round(samples[1][1])} ms |`,
    );
  };
  const cell = page.getByRole("button", {
    name: /^Habit 1, Monday, November 16, 2026/,
  });

  await measure("Month grid, 25 active habits by 30 rows", async () => {
    await page.goto("/");
    await expect(page.locator("h1").first()).toBeVisible();
    return time(page, () => page.goto("/habits"), cell);
  });
  await measure("Previous month in the grid", async () => {
    await page.goto("/habits");
    await expect(cell).toBeVisible();
    return time(
      page,
      () => page.getByRole("button", { name: /^Previous month/ }).click(),
      page.getByRole("heading", { name: "October 2026" }),
    );
  });
  await measure("History: open the year heatmap (366 days)", async () => {
    await page.goto("/habits");
    await expect(cell).toBeVisible();
    await page.getByRole("button", { name: "Show history" }).click();
    return time(
      page,
      () => page.getByRole("button", { name: "Year" }).click(),
      page.locator('[data-date="2026-02-28"]'),
    );
  });
  await measure("Trends: open the panel (reads 366 days)", async () => {
    await page.goto("/habits");
    await expect(cell).toBeVisible();
    return time(
      page,
      () => page.getByRole("button", { name: "Show trends" }).click(),
      page.getByRole("heading", { name: "Habit trends" }),
    );
  });
  console.log(
    `\n30 habits, ${fixture.completions.length} completions\n| Step | Time to content | Long tasks |\n|---|---:|---:|\n${rows.join("\n")}`,
  );
});
