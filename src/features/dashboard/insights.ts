import type {
  ProgressAnalytics,
  ScheduleAnalytics,
  WorkspaceAnalytics,
} from "../../database/analytics";
import type { HabitStatistics } from "../../database/habits";
import { links } from "../../app/links";
import { fullDate } from "../calendar/monthGrid";

/**
 * Deterministic, neutral statements about overdue work, habit days, tomorrow's
 * schedule, and milestones, each with the place its numbers come from. Plain
 * rules over the canonical queries: no scoring, no prediction, no judgment.
 * A source that is missing or truncated produces no statement, never a zero.
 */
export interface Insight {
  /** Stable across runs, so the order and keys never shuffle. */
  id: string;
  text: string;
  /** Where to inspect the records behind the statement. */
  to: string;
  /** What opening it does. */
  action: string;
}

export interface InsightInput {
  today: string;
  /** The day after `today`, as a local date. */
  tomorrow: string;
  period: { from: string; to: string };
  project: string | null;
  progress: ProgressAnalytics | null;
  workspace: WorkspaceAnalytics | null;
  habits: HabitStatistics | null;
  /** The schedule for `tomorrow` alone. */
  schedule: ScheduleAnalytics | null;
}

/** How far ahead milestones are mentioned, in days. */
export const MILESTONE_DAYS = 14;
const MAX_MILESTONES = 3;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function span(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} h` : "", rest || !hours ? `${rest} min` : ""]
    .filter(Boolean)
    .join(" ");
}

const issueList = (project: string | null, extra: Record<string, string>) => {
  const params = new URLSearchParams(extra);
  if (project) params.set("project", project);
  return `/issues?${params}`;
};

export function buildInsights(input: InsightInput): Insight[] {
  const out: Insight[] = [];
  const { progress, workspace, habits, schedule, project } = input;

  if (progress) {
    const n = progress.totals.overdue;
    out.push({
      id: "overdue-issues",
      text:
        n === 0
          ? `No open issues are overdue as of ${fullDate(input.today)}.`
          : `${plural(n, "open issue is", "open issues are")} overdue: due before ${fullDate(input.today)}.`,
      to: issueList(project, { due: "overdue" }),
      action: "Open overdue issues",
    });
  }

  const projects = workspace?.projects.data;
  if (projects) {
    const n = projects.overdue;
    out.push({
      id: "overdue-projects",
      text:
        n === 0
          ? `No project has a target date before ${fullDate(input.today)} while still planned, active, or on hold.`
          : `${plural(n, "project has", "projects have")} a target date before ${fullDate(input.today)} and ${n === 1 ? "is" : "are"} still planned, active, or on hold.`,
      to: "/projects",
      action: "Open projects",
    });
  }

  if (progress) {
    // Milestones in the deadline list: open, overdue or due within two weeks,
    // nearest first. The list is capped, so each is stated by itself and the
    // number of milestones is never claimed.
    const milestones = progress.deadlines
      .filter((d) => d.kind === "milestone")
      .sort(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title),
      )
      .slice(0, MAX_MILESTONES);
    for (const m of milestones)
      out.push({
        id: `milestone-${m.id}`,
        text: m.overdue
          ? `Milestone ${m.title}${m.projectName ? ` (${m.projectName})` : ""} was due ${fullDate(m.dueDate)} and is still open.`
          : `Milestone ${m.title}${m.projectName ? ` (${m.projectName})` : ""} is due ${fullDate(m.dueDate)}.`,
        to: m.projectId
          ? `/issues/milestones?project=${encodeURIComponent(m.projectId)}`
          : "/issues/milestones",
        action: "Open milestones",
      });
  }

  if (habits) {
    const { eligible, completed } = habits.summary;
    out.push({
      id: "habit-days",
      text:
        eligible === 0
          ? `No habit days were eligible from ${fullDate(input.period.from)} to ${fullDate(habits.through)}.`
          : `From ${fullDate(input.period.from)} to ${fullDate(habits.through)}, ${completed} of ${plural(eligible, "eligible habit day")} ${completed === 1 ? "was" : "were"} completed.`,
      to: "/habits",
      action: "Open habits",
    });
  }

  if (schedule) {
    const { totals, truncated } = schedule;
    const tomorrow = fullDate(input.tomorrow);
    const to = links.calendar(input.tomorrow, "day");
    if (truncated)
      // Totals would be lower bounds, which exact text would misstate.
      out.push({
        id: "tomorrow",
        text: `Tomorrow, ${tomorrow}, has more calendar items than can be totaled here.`,
        to,
        action: "Open the calendar",
      });
    else {
      const items = totals.events + totals.workBlocks;
      out.push({
        id: "tomorrow",
        text:
          items === 0 && totals.deadlines === 0
            ? `Nothing is scheduled for tomorrow, ${tomorrow}.`
            : `Tomorrow, ${tomorrow}: ${plural(totals.events, "event")}, ${plural(totals.workBlocks, "planned work session")}, and ${plural(totals.deadlines, "open due date")}; ${span(totals.busyMinutes)} scheduled.`,
        to,
        action: "Open tomorrow in the calendar",
      });
    }
  }
  return out;
}
