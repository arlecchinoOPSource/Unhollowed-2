import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import {
  issueError,
  issueKey,
  queryIssues,
  setIssueDueDate,
  type IssueSummary,
} from "../../database/issues";
import { addDays } from "../today/dates";
import { useLocalToday } from "../today/useLocalToday";
import { DayIssue } from "./IssueCalendar";
import { fullDate } from "./monthGrid";
import "./calendar.css";

/** More than this many overdue issues are summarized by count. */
const LIMIT = 50;

/**
 * Open issues due before today, whichever calendar view is shown. They come
 * from the issue records, so nothing is copied into the calendar, and the
 * `project` filter applies as it does in Month. Rescheduling changes only
 * `due_date` through the issue command.
 */
export function OverdueIssues({
  revision,
  onChanged,
}: {
  revision: number;
  onChanged: () => void;
}) {
  const today = useLocalToday();
  const location = useLocation();
  const [params] = useSearchParams();
  const project = params.get("project") ?? "";
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let current = true;
    queryIssues({
      state: "open",
      dueBefore: addDays(today, -1),
      undated: "exclude",
      sort: "due",
      direction: "asc",
      limit: LIMIT,
      ...(project === "inbox"
        ? { inbox: true }
        : project
          ? { projectIds: [project] }
          : {}),
    }).then(
      (page) => {
        if (!current) return;
        setIssues(page.issues);
        setTotal(page.total);
      },
      (cause) => {
        if (current) setError(issueError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [today, project, revision]);

  function reschedule(issue: IssueSummary, dueDate: string) {
    if (!dueDate || dueDate === issue.dueDate) return;
    setError("");
    setMessage("");
    setIssueDueDate(issue.id, dueDate).then(
      (saved) => {
        setMessage(`${issueKey(saved)} is now due ${fullDate(dueDate)}.`);
        onChanged();
      },
      (cause) =>
        setError(
          `Could not reschedule ${issueKey(issue)}. It is still due ${fullDate(issue.dueDate!)}. ${issueError(cause)}`,
        ),
    );
  }

  if (error) return <p role="alert">{error}</p>;
  if (!issues || (issues.length === 0 && !message)) return null;
  return (
    <section className="calendar-overdue-panel" aria-labelledby="overdue-title">
      <h2 id="overdue-title">Overdue ({total})</h2>
      <p role="status">{message}</p>
      <ul className="calendar-day-list">
        {issues.map((issue) => (
          <DayIssue
            key={issue.id}
            issue={issue}
            from={`${location.pathname}${location.search}`}
            overdue
            onReschedule={(date) => reschedule(issue, date)}
          />
        ))}
      </ul>
      {total > issues.length && (
        <p>Showing the {issues.length} longest overdue.</p>
      )}
    </section>
  );
}
