import { links } from "../../app/links";
import type { Drill } from "../../components/charts/Chart";
import { fullDate } from "../calendar/monthGrid";
import type { Bucket } from "./comparison";

/**
 * Where a chart point's records are. A drilldown opens exactly the cohort the
 * metric counted, with the same dates, or says why there is none.
 */

const span = (b: Bucket) =>
  b.start === b.end
    ? fullDate(b.start)
    : `${fullDate(b.start)} to ${fullDate(b.end)}`;

/** Done issues whose completion falls on the bucket's local days. */
export function completedIssues(
  b: Bucket,
  count: number,
  project: string | null,
): Drill {
  const params = new URLSearchParams({
    state: "closed",
    status: "done",
    completedFrom: b.start,
    completedTo: b.end,
  });
  if (project) params.set("project", project);
  return {
    to: `/issues?${params}`,
    text: `Open ${count} ${count === 1 ? "issue" : "issues"} completed ${span(b)}`,
  };
}

/** The calendar at the bucket's first day: the day, or the agenda from it. */
export function scheduledTime(b: Bucket): Drill {
  return {
    to: links.calendar(b.start, b.start === b.end ? "day" : "agenda"),
    text:
      b.start === b.end
        ? `Open the calendar for ${fullDate(b.start)}`
        : `Open the agenda from ${fullDate(b.start)}`,
  };
}

/** One habit's history at the day, or the habit grid for a ratio over many. */
export function habitDays(b: Bucket, habit: string | null): Drill {
  return habit
    ? {
        to: links.habit(habit, b.start),
        text: `Open this habit on ${fullDate(b.start)}`,
      }
    : { to: "/habits", text: `Open habits (${span(b)})` };
}

export const NOTES = {
  mood: "Mood is an average of ratings, not a list of records. Open check-ins to see each day.",
  habits:
    "Completion is a ratio across habits. The habit grid shows the days behind it.",
} as const;
