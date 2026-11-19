import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

// Automated accessibility checks for habit tracking, check-ins, and the
// dashboard, with data loaded, every panel open, and both themes. They sit
// beside accessibility.spec.ts, which scans each page once with seeded issues.
// docs/PERFORMANCE.md records what this does and does not cover.

const metric = (samples: number, average: number | null) => ({
  samples,
  average,
});
const bucket = (
  start: string,
  end: string,
  eligible: number,
  completed: number,
) => ({
  start,
  end,
  eligible,
  completed,
  percent: eligible ? (completed * 100) / eligible : null,
});
const load = (over: object = {}) => ({
  events: 0,
  allDayEvents: 0,
  timedEvents: 0,
  workBlocks: 0,
  deadlines: 0,
  eventMinutes: 0,
  workBlockMinutes: 0,
  busyMinutes: 0,
  overlapMinutes: 0,
  ...over,
});
const totals = (
  open: number,
  done: number,
  canceled: number,
  overdue: number,
) => ({
  total: open + done + canceled,
  open,
  done,
  canceled,
  completionPercent: done + open ? (done * 100) / (done + open) : null,
  overdue,
  upcoming: 1,
  undatedOpen: 0,
});

/** Engine-shaped fixtures with every state the pages draw: data, a gap, a zero. */
const fixtures = {
  __workspace: {
    issues: {
      availability: "available",
      reason: null,
      data: {
        created: 4,
        completed: 2,
        due: 3,
        dueCompleted: 2,
        duePercent: 66.7,
        open: 7,
        overdue: 1,
      },
    },
    calendar: {
      availability: "available",
      reason: null,
      data: {
        events: 3,
        allDayEvents: 1,
        timedEvents: 2,
        scheduledMinutes: 120,
        workBlocks: 1,
        workBlockMinutes: 60,
        truncated: false,
      },
    },
    habits: {
      availability: "available",
      reason: null,
      data: {
        eligible: 7,
        completed: 3,
        percent: (3 * 100) / 7,
        practice: { current: 2, longest: 4 },
      },
    },
  },
  __habitStats: {
    today: "2026-11-16",
    from: "2026-10-18",
    to: "2026-11-16",
    through: "2026-11-16",
    summary: { eligible: 14, completed: 6, percent: (6 * 100) / 14 },
    habits: [
      {
        habitId: "habit-1",
        name: "Walk",
        archived: false,
        eligible: 11,
        completed: 6,
        percent: (6 * 100) / 11,
        streaks: { current: 2, longest: 4 },
      },
      {
        habitId: "habit-2",
        name: "Read",
        archived: true,
        eligible: 3,
        completed: 0,
        percent: 0,
        streaks: { current: 0, longest: 0 },
      },
      {
        habitId: "habit-3",
        name: "Later",
        archived: false,
        eligible: 0,
        completed: 0,
        percent: null,
        streaks: { current: 0, longest: 0 },
      },
    ],
    days: [
      bucket("2026-11-14", "2026-11-14", 0, 0),
      bucket("2026-11-15", "2026-11-15", 2, 1),
      bucket("2026-11-16", "2026-11-16", 2, 0),
    ],
    weeks: [
      bucket("2026-11-09", "2026-11-15", 7, 3),
      bucket("2026-11-16", "2026-11-16", 0, 0),
    ],
    months: [bucket("2026-11-01", "2026-11-16", 14, 6)],
    practice: { current: 2, longest: 4 },
  },
  __progress: {
    totals: totals(2, 2, 2, 1),
    projects: [
      {
        projectId: "project-1",
        name: "Studio launch",
        status: "active",
        issues: totals(2, 1, 1, 1),
        milestonesOpen: 1,
        milestonesClosed: 1,
        objectives: 1,
        objectiveLinked: 2,
        objectiveDone: 1,
      },
      {
        projectId: "project-2",
        name: "Garden",
        status: "active",
        issues: totals(0, 0, 0, 0),
        milestonesOpen: 0,
        milestonesClosed: 0,
        objectives: 0,
        objectiveLinked: 0,
        objectiveDone: 0,
      },
    ],
    deadlines: [
      {
        kind: "issue",
        id: "seed-1",
        number: 1,
        title: "Renew passport",
        projectId: "project-1",
        projectName: "Studio launch",
        dueDate: "2026-11-12",
        overdue: true,
      },
    ],
    trend: {
      granularity: "day",
      buckets: [
        { start: "2026-11-09", end: "2026-11-09", completed: 0 },
        { start: "2026-11-10", end: "2026-11-10", completed: 2 },
      ],
      doneTotal: 3,
      withTime: 2,
      withoutTime: 1,
    },
  },
  __schedule: {
    truncated: false,
    totals: load({
      events: 3,
      allDayEvents: 1,
      timedEvents: 2,
      workBlocks: 1,
      deadlines: 2,
      eventMinutes: 120,
      workBlockMinutes: 60,
      busyMinutes: 120,
      overlapMinutes: 60,
    }),
    days: [
      { start: "2026-11-09", end: "2026-11-09", ...load() },
      {
        start: "2026-11-10",
        end: "2026-11-10",
        ...load({
          timedEvents: 2,
          events: 2,
          eventMinutes: 120,
          busyMinutes: 120,
        }),
      },
    ],
    weeks: [],
    projects: [
      {
        kind: "unassigned",
        projectId: null,
        name: "No project",
        events: 1,
        eventMinutes: 0,
        workBlocks: 1,
        workBlockMinutes: 60,
        deadlines: 1,
      },
    ],
    upcoming: {
      events: 1,
      workBlocks: 0,
      deadlines: 1,
      next: [
        {
          kind: "event",
          id: "e1",
          title: "Planning",
          allDay: false,
          when: "2026-11-17T09:00",
        },
        {
          kind: "deadline",
          id: "i1",
          title: "Renew passport",
          allDay: true,
          when: "2026-11-18",
        },
      ],
    },
  },
  __checkinAnalytics: {
    without: {
      from: "2026-10-18",
      to: "2026-11-16",
      through: "2026-11-16",
      daysInPeriod: 30,
      daysRecorded: 3,
      mood: metric(3, 3.5),
      energy: metric(0, null),
      focus: metric(3, 4),
      points: [
        { date: "2026-11-02", mood: 4, energy: null, focus: 4 },
        { date: "2026-11-03", mood: 2, energy: null, focus: null },
        { date: "2026-11-10", mood: null, energy: null, focus: 4 },
      ],
      weeks: [
        {
          start: "2026-11-02",
          end: "2026-11-08",
          mood: metric(2, 3),
          energy: metric(0, null),
          focus: metric(1, 4),
          habits: null,
        },
      ],
      months: [
        {
          start: "2026-11-01",
          end: "2026-11-16",
          mood: metric(3, 3.5),
          energy: metric(0, null),
          focus: metric(3, 4),
          habits: null,
        },
      ],
      habits: null,
    },
  },
  __seedCheckins: [
    {
      date: "2026-11-10",
      mood: 3,
      energy: null,
      focus: 2,
      note: "Private words",
    },
    { date: "2026-11-12", mood: null, energy: 4, focus: null, note: null },
  ],
  __seedHabits: {
    today: "2026-11-16",
    habits: [
      { name: "Walk", startDate: "2026-11-01" },
      { name: "Read", startDate: "2026-11-01", archivedOn: "2026-11-10" },
      { name: "Later", startDate: "2026-12-01" },
    ],
    completions: [
      ["habit-1", "2026-11-05"],
      ["habit-1", "2026-11-06"],
      ["habit-2", "2026-11-10"],
    ],
  },
  __seedEvents: [
    {
      title: "Morning walk",
      allDay: true,
      timeZone: null,
      startDate: "2026-11-02",
      endDate: "2026-11-03",
      repeatFreq: "daily",
      repeatInterval: 1,
    },
  ],
  __pickedBackup: {
    name: "ember-backup.json",
    content: JSON.stringify({
      format: "ember-backup",
      version: 1,
      habits: [
        {
          id: "0123456789abcdef0123456789abcdef",
          name: "Synthetic read",
          sortOrder: 0,
          startDate: "2028-02-01",
          archivedAt: null,
        },
      ],
      completions: [["0123456789abcdef0123456789abcdef", "2028-02-28"]],
    }),
  },
};

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, label: string, found: string[]) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(TAGS)
    .analyze();
  for (const violation of violations)
    found.push(
      `${label} ${violation.id}: ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(" "))
        .join(", ")}`,
    );
}

async function setup(page: Page, scheme: "light" | "dark") {
  await installIpcMock(page);
  await page.addInitScript((data) => {
    Object.assign(window, data, {
      // A Set does not survive serialization, so it is built in the page.
      __routineLinks: new Set(["habit-1|event-1"]),
    });
  }, fixtures);
  await page.clock.setFixedTime(new Date("2026-11-16T10:00:00+01:00"));
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode`, () => {
    test("habit tracking: grid, trends, history, and every dialog", async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await setup(page, scheme);
      const found: string[] = [];
      await page.goto("/habits");
      await expect(
        page.getByRole("button", { name: /^Walk, / }).first(),
      ).toBeVisible();
      await scan(page, "habits grid", found);

      await page.getByRole("button", { name: "Show trends" }).click();
      await expect(
        page.getByRole("img", { name: /^Weekly completion/ }),
      ).toBeVisible();
      for (const summary of await page
        .locator(".habit-dashboard summary")
        .all())
        await summary.click();
      await scan(page, "habit trends", found);

      await page.getByRole("button", { name: "Show history" }).click();
      const history = page.getByRole("region", { name: "Habit history" });
      await expect(history.locator("[data-date]").first()).toBeVisible();
      await history.locator("[data-date]").nth(5).click();
      await scan(page, "history month", found);
      await history.getByRole("button", { name: "Year" }).click();
      await scan(page, "history year", found);

      await page.getByRole("button", { name: "Manage habits" }).click();
      const manager = page.getByRole("dialog", { name: "Manage habits" });
      await manager.getByText("Routines of Walk").click();
      await expect(
        manager.getByRole("list", { name: "Routines of Walk" }),
      ).toBeVisible();
      await manager.getByText("History of Read").click();
      await scan(page, "manage habits", found);
      await manager
        .getByRole("button", { name: "Delete Read permanently" })
        .click();
      await expect(
        manager.getByRole("heading", { name: /^Delete Read/ }),
      ).toBeFocused();
      await scan(page, "habit deletion review", found);
      await page.keyboard.press("Escape");
      await expect(
        manager.getByRole("heading", { name: /^Delete Read/ }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(manager).toBeHidden();

      await page.getByRole("button", { name: "Import from Ember" }).click();
      const imports = page.getByRole("dialog", { name: "Import from Ember" });
      await imports
        .getByRole("button", { name: "Choose backup file…" })
        .click();
      await expect(
        imports.getByRole("list", { name: "Imported habits" }),
      ).toBeVisible();
      await scan(page, "habit import preview", found);
      await page.keyboard.press("Escape");
      await expect(imports).toBeHidden();

      await page.getByRole("button", { name: "Backup and restore" }).click();
      await expect(
        page.getByRole("dialog", { name: "Backup and restore" }),
      ).toBeVisible();
      await scan(page, "habit backup", found);
      expect(found, found.join("\n")).toEqual([]);
    });

    test("check-ins: the form, history, and trends", async ({ page }) => {
      test.setTimeout(60_000);
      await setup(page, scheme);
      const found: string[] = [];
      await page.goto("/mood");
      await expect(page.getByRole("group", { name: /^Mood/ })).toBeVisible();
      await scan(page, "check-in form", found);
      await page.getByLabel("Date", { exact: true }).fill("2026-11-10");
      await expect(page.getByLabel("Note (optional)")).toHaveValue(
        "Private words",
      );
      await page
        .getByRole("group", { name: /^Mood/ })
        .getByRole("radio", { name: "5", exact: true })
        .check();
      await scan(page, "check-in edited", found);
      for (const summary of await page.locator(".mood-trends summary").all())
        await summary.click();
      await page
        .getByLabel("Show habit completion beside weeks and months")
        .check();
      await scan(page, "check-in trends", found);
      expect(found, found.join("\n")).toEqual([]);
    });

    test("dashboard: every section, filters, and controls", async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await setup(page, scheme);
      const found: string[] = [];
      await page.goto("/dashboards");
      await expect(
        page.getByRole("heading", { name: "At a glance" }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Mood, energy, and focus" }),
      ).toBeVisible();
      await page.getByText("Sections", { exact: true }).click();
      for (const summary of await page.locator(".dash-section summary").all())
        await summary.click();
      await scan(page, "dashboard", found);
      await page
        .getByRole("button", { name: "Custom dates", exact: true })
        .click();
      await page
        .getByRole("group", { name: "Custom dates" })
        .getByLabel("From")
        .fill("2026-11-12");
      await page
        .getByRole("group", { name: "Custom dates" })
        .getByLabel("To")
        .fill("2026-11-01");
      await expect(page.getByRole("alert").first()).toBeVisible();
      await scan(page, "dashboard with an invalid period", found);
      await page
        .locator(".dash-controls select")
        .first()
        .selectOption({ label: "Studio launch" });
      await scan(page, "dashboard with a project filter", found);
      expect(found, found.join("\n")).toEqual([]);
    });

    test("every stop shows focus and nothing moves", async ({ page }) => {
      test.setTimeout(120_000);
      await setup(page, scheme);
      const unmarked = new Set<string>();
      const moving = new Set<string>();
      for (const route of ["/habits", "/mood", "/dashboards"]) {
        await page.goto(route);
        await expect(page.locator("h1").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        if (route === "/habits") {
          await page.getByRole("button", { name: "Show trends" }).click();
          await page.getByRole("button", { name: "Show history" }).click();
        }
        for (let stop = 0; stop < 120; stop += 1) {
          await page.keyboard.press("Tab");
          const result = await page.evaluate(() => {
            const element = document.activeElement as HTMLElement | null;
            if (!element || element === document.body) return null;
            const style = getComputedStyle(element);
            const visible =
              (style.outlineStyle !== "none" &&
                parseFloat(style.outlineWidth) >= 2) ||
              style.boxShadow !== "none";
            const name =
              element.getAttribute("aria-label") ??
              (element.id ||
                `${element.getAttribute("type") ?? ""} ${element.textContent?.trim().slice(0, 40) ?? ""}`);
            return visible ? "" : `${element.tagName} "${name}"`;
          });
          if (result === null) break;
          if (result) unmarked.add(`${route} ${result}`);
        }
        // Reduced motion is requested, so no element may animate or transition.
        const animated = await page.evaluate(() =>
          [...document.querySelectorAll("main *, #main *")]
            .filter((element) => {
              const style = getComputedStyle(element);
              return (
                parseFloat(style.transitionDuration) > 0.01 ||
                (style.animationName !== "none" &&
                  parseFloat(style.animationDuration) > 0.01)
              );
            })
            .map(
              (element) =>
                `${element.tagName}.${(element as HTMLElement).className}`,
            ),
        );
        for (const name of animated) moving.add(`${route} ${name}`);
      }
      expect([...unmarked], [...unmarked].join("\n")).toEqual([]);
      expect([...moving], [...moving].join("\n")).toEqual([]);
    });

    test("nothing scrolls sideways at the 620 px minimum window width", async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await setup(page, scheme);
      await page.setViewportSize({ width: 620, height: 600 });
      const wide: string[] = [];
      for (const route of ["/habits", "/mood", "/dashboards"]) {
        await page.goto(route);
        await expect(page.locator("h1").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        if (route === "/habits") {
          await page.getByRole("button", { name: "Show trends" }).click();
          await page.getByRole("button", { name: "Show history" }).click();
          await page
            .getByRole("region", { name: "Habit history" })
            .getByRole("button", { name: "Year" })
            .click();
        }
        await page.waitForTimeout(200);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        if (overflow > 0) wide.push(`${route} by ${overflow}px`);
      }
      expect(wide, wide.join("\n")).toEqual([]);
    });
  });
}
