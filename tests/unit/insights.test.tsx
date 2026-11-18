import { expect, test } from "vitest";
import type {
  ProgressAnalytics,
  ScheduleAnalytics,
  WorkspaceAnalytics,
} from "../../src/database/analytics";
import type { HabitStatistics } from "../../src/database/habits";
import {
  buildInsights,
  type InsightInput,
} from "../../src/features/dashboard/insights";

const progress = (
  over: Partial<ProgressAnalytics["totals"]> = {},
  deadlines: ProgressAnalytics["deadlines"] = [],
) =>
  ({
    totals: { overdue: 2, ...over },
    deadlines,
  }) as unknown as ProgressAnalytics;
const workspace = (overdue: number | null) =>
  ({
    projects: {
      availability: "available",
      reason: null,
      data: overdue === null ? null : { overdue },
    },
  }) as unknown as WorkspaceAnalytics;
const habits = (eligible: number, completed: number) =>
  ({
    summary: { eligible, completed, percent: null },
    through: "2026-11-18",
  }) as unknown as HabitStatistics;
const schedule = (t: Partial<ScheduleAnalytics["totals"]>, truncated = false) =>
  ({
    truncated,
    totals: { events: 0, workBlocks: 0, deadlines: 0, busyMinutes: 0, ...t },
  }) as unknown as ScheduleAnalytics;

const base: InsightInput = {
  today: "2026-11-18",
  tomorrow: "2026-11-19",
  period: { from: "2026-10-20", to: "2026-11-18" },
  project: null,
  progress: null,
  workspace: null,
  habits: null,
  schedule: null,
};
const ids = (input: InsightInput) => buildInsights(input).map((i) => i.id);

test("no data, no statements: missing is never turned into zero", () => {
  expect(buildInsights(base)).toEqual([]);
  // A source that answered but had no projects section is still silent.
  expect(ids({ ...base, workspace: workspace(null) })).toEqual([]);
});

test("numbers and dates match the sources, in a fixed order", () => {
  const input: InsightInput = {
    ...base,
    progress: progress({ overdue: 3 }, [
      {
        kind: "milestone",
        id: "m2",
        number: null,
        title: "Gamma",
        projectId: "p1",
        projectName: "Studio",
        dueDate: "2026-12-01",
        overdue: false,
      },
      {
        kind: "issue",
        id: "i1",
        number: 4,
        title: "Skip me",
        projectId: null,
        projectName: null,
        dueDate: "2026-11-20",
        overdue: false,
      },
      {
        kind: "milestone",
        id: "m1",
        number: null,
        title: "Beta",
        projectId: "p1",
        projectName: "Studio",
        dueDate: "2026-11-12",
        overdue: true,
      },
    ]),
    workspace: workspace(1),
    habits: habits(30, 21),
    schedule: schedule({
      events: 2,
      workBlocks: 1,
      deadlines: 1,
      busyMinutes: 210,
    }),
  };
  const out = buildInsights(input);
  expect(out.map((i) => i.id)).toEqual([
    "overdue-issues",
    "overdue-projects",
    "milestone-m1",
    "milestone-m2",
    "habit-days",
    "tomorrow",
  ]);
  const text = Object.fromEntries(out.map((i) => [i.id, i.text]));
  expect(text["overdue-issues"]).toBe(
    "3 open issues are overdue: due before Wednesday, November 18, 2026.",
  );
  expect(text["overdue-projects"]).toContain(
    "1 project has a target date before",
  );
  expect(text["milestone-m1"]).toBe(
    "Milestone Beta (Studio) was due Thursday, November 12, 2026 and is still open.",
  );
  expect(text["milestone-m2"]).toBe(
    "Milestone Gamma (Studio) is due Tuesday, December 1, 2026.",
  );
  expect(text["habit-days"]).toBe(
    "From Tuesday, October 20, 2026 to Wednesday, November 18, 2026, 21 of 30 eligible habit days were completed.",
  );
  expect(text.tomorrow).toBe(
    "Tomorrow, Thursday, November 19, 2026: 2 events, 1 planned work session, and 1 open due date; 3 h 30 min scheduled.",
  );
  // Same input, same output.
  expect(buildInsights(input)).toEqual(out);
});

test("each statement links to where its records are", () => {
  const out = Object.fromEntries(
    buildInsights({
      ...base,
      project: "p9",
      progress: progress(),
      workspace: workspace(0),
      schedule: schedule({}),
    }).map((i) => [i.id, i]),
  );
  expect(out["overdue-issues"].to).toBe("/issues?due=overdue&project=p9");
  expect(out["overdue-projects"].to).toBe("/projects");
  expect(out.tomorrow.to).toBe("/calendar?view=day&date=2026-11-19");
});

test("an answered zero is stated plainly, and is not a prediction", () => {
  const out = buildInsights({
    ...base,
    progress: progress({ overdue: 0 }),
    workspace: workspace(0),
    habits: habits(0, 0),
    schedule: schedule({}),
  });
  expect(out.map((i) => i.text)).toEqual([
    "No open issues are overdue as of Wednesday, November 18, 2026.",
    "No project has a target date before Wednesday, November 18, 2026 while still planned, active, or on hold.",
    "No habit days were eligible from Tuesday, October 20, 2026 to Wednesday, November 18, 2026.",
    "Nothing is scheduled for tomorrow, Thursday, November 19, 2026.",
  ]);
  for (const { text } of out) expect(text).not.toMatch(/will|likely|should/);
});

test("a truncated calendar produces no total", () => {
  const [item] = buildInsights({
    ...base,
    schedule: schedule({ events: 5, busyMinutes: 60 }, true),
  });
  expect(item.text).toContain("more calendar items than can be totaled");
  expect(item.text).not.toMatch(/\d+ h|\d+ min|5 events/);
});

test("singular and plural wording follows the number", () => {
  const [one] = buildInsights({ ...base, progress: progress({ overdue: 1 }) });
  expect(one.text).toMatch(/^1 open issue is overdue/);
  const [habit] = buildInsights({ ...base, habits: habits(1, 1) });
  expect(habit.text).toContain("1 of 1 eligible habit day was completed");
});

test("at most three milestones are listed, nearest first", () => {
  const many = ["d", "a", "c", "b", "e"].map((t, i) => ({
    kind: "milestone" as const,
    id: `m${i}`,
    number: null,
    title: t,
    projectId: null,
    projectName: null,
    dueDate: `2026-11-2${i}`,
    overdue: false,
  }));
  const out = buildInsights({ ...base, progress: progress({}, many) });
  const titles = out
    .filter((i) => i.id.startsWith("milestone"))
    .map((i) => i.text);
  expect(titles).toHaveLength(3);
  expect(titles[0]).toContain("Milestone d");
});
