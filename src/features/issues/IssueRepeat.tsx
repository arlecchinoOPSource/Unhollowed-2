import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  getIssueRecurrence,
  issueError,
  repeatFrequencies,
  setIssueRecurrence,
  type Issue,
  type Recurrence,
  type RepeatFrequency,
} from "../../database/issues";
import { dayLabel } from "../today/dates";

function describe(rule: Recurrence): string {
  const { unit, units } = repeatFrequencies[rule.frequency];
  return rule.interval === 1
    ? `Repeats every ${unit}`
    : `Repeats every ${rule.interval} ${units}`;
}

/**
 * The issue page's repeat controls: choose a rule, change it, or stop it,
 * and follow the link to the next occurrence once one exists.
 */
export function IssueRepeat({
  issue,
  today,
  onSaved,
  onError,
}: {
  issue: Issue;
  today: string;
  onSaved: (issue: Issue, message: string) => void;
  onError: (message: string) => void;
}) {
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null);
  const [frequency, setFrequency] = useState<RepeatFrequency | "">("");
  const [interval, setInterval] = useState("1");
  const [saving, setSaving] = useState(false);

  // Reload after changes that can create an occurrence or change the rule.
  useEffect(() => {
    let current = true;
    getIssueRecurrence(issue.id).then(
      (loaded) => {
        if (!current) return;
        setRecurrence(loaded);
        const active = loaded && !loaded.stopped ? loaded : null;
        setFrequency(active?.frequency ?? "");
        setInterval(String(active?.interval ?? 1));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [issue.id, issue.status, issue.recurrenceId, issue.recurring]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const count = Number(interval);
    if (frequency && !(Number.isInteger(count) && count >= 1 && count <= 99)) {
      onError("Enter a whole number from 1 to 99.");
      return;
    }
    setSaving(true);
    try {
      const saved = await setIssueRecurrence(
        issue.id,
        frequency ? { frequency, interval: count } : null,
      );
      onSaved(
        saved,
        frequency ? "Repeat saved." : "This issue no longer repeats.",
      );
    } catch (cause) {
      onError(issueError(cause));
    } finally {
      setSaving(false);
    }
  }

  const active = recurrence && !recurrence.stopped ? recurrence : null;
  const next =
    recurrence && recurrence.latestIssueId !== issue.id ? recurrence : null;
  const unit = frequency ? repeatFrequencies[frequency] : null;

  return (
    <form className="issue-repeat-form" onSubmit={save}>
      <fieldset>
        <legend>Repeat</legend>
        <p className="issue-repeat-summary">
          {active
            ? describe(active)
            : recurrence?.stopped
              ? "Stopped repeating"
              : "Does not repeat"}
        </p>
        <label>
          Frequency
          <select
            value={frequency}
            onChange={(event) =>
              setFrequency(event.target.value as RepeatFrequency | "")
            }
          >
            <option value="">Does not repeat</option>
            {Object.entries(repeatFrequencies).map(([value, { label }]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {unit && (
          <label>
            Every
            <span className="issue-repeat-interval">
              <input
                type="number"
                min={1}
                max={99}
                step={1}
                inputMode="numeric"
                value={interval}
                onChange={(event) => setInterval(event.target.value)}
              />
              {Number(interval) === 1 ? unit.unit : unit.units}
            </span>
          </label>
        )}
        {frequency && !issue.dueDate && (
          <p>Set a due date first. Repeats start from the due date.</p>
        )}
        <button
          type="submit"
          className="action"
          aria-disabled={saving || Boolean(frequency && !issue.dueDate)}
        >
          {saving
            ? "Saving…"
            : frequency
              ? "Save repeat"
              : active
                ? "Stop repeating"
                : "Save repeat"}
        </button>
        {next && (
          <p>
            Next occurrence:{" "}
            <Link to={`/issues/${next.latestIssueId}`}>
              ISS-{next.latestNumber}
            </Link>
            {next.latestDueDate &&
              `, due ${dayLabel(next.latestDueDate, today)}`}
            {next.latestClosed && " (closed)"}
          </p>
        )}
      </fieldset>
    </form>
  );
}
