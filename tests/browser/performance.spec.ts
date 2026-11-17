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
