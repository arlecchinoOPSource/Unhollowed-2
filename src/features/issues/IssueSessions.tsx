import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { schedulingError } from "../../database/calendars";
import {
  createWorkBlock,
  deleteWorkBlock,
  deviceZone,
  listWorkBlocks,
  updateWorkBlock,
  type WorkBlock,
} from "../../database/events";
import { displayClock, useCalendarPreferences } from "../calendar/preferences";
import { fullDate } from "../calendar/monthGrid";
import { useLocalToday } from "../today/useLocalToday";
import "../calendar/calendar.css";

interface Draft {
  /** The session being edited, or null for a new one. */
  id: string | null;
  date: string;
  start: string;
  end: string;
  zone: string;
}

function describe(block: WorkBlock, twelveHour: boolean) {
  const [day, start] = block.startLocal.split("T");
  const [endDay, end] = block.endLocal.split("T");
  const to = endDay === day ? end : `${endDay} ${end}`;
  return `${fullDate(day)}, ${displayClock(start, twelveHour)}–${displayClock(to.slice(-5), twelveHour)}${endDay === day ? "" : ` (${endDay})`}`;
}

/**
 * The issue's scheduled work sessions: add, move, and delete. Sessions are
 * their own records, apart from the due date, so changing them never
 * changes the issue's status or deadline. They stay listed after the issue
 * is completed or archived.
 */
export function IssueSessions({ issueId }: { issueId: string }) {
  const today = useLocalToday();
  const twelveHour = useCalendarPreferences().twelveHour;
  const [blocks, setBlocks] = useState<WorkBlock[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    listWorkBlocks(issueId).then(
      (loaded) => current && setBlocks(loaded),
      (cause) => current && setError(schedulingError(cause)),
    );
    return () => {
      current = false;
    };
  }, [issueId]);

  function edit(block?: WorkBlock) {
    setError("");
    setMessage("");
    setDraft(
      block
        ? {
            id: block.id,
            date: block.startLocal.slice(0, 10),
            start: block.startLocal.slice(11),
            end: block.endLocal.slice(11),
            zone: block.timeZone,
          }
        : {
            id: null,
            date: today,
            start: "09:00",
            end: "10:00",
            zone: deviceZone(),
          },
    );
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    const timing = {
      timeZone: draft.zone,
      start: `${draft.date}T${draft.start}`,
      end: `${draft.date}T${draft.end}`,
    };
    try {
      const saved = draft.id
        ? await updateWorkBlock(draft.id, timing)
        : await createWorkBlock(issueId, timing);
      setBlocks((current) =>
        [...(current ?? []).filter(({ id }) => id !== saved.id), saved].sort(
          (a, b) =>
            a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id),
        ),
      );
      setMessage(draft.id ? "Session moved." : "Session added.");
      setDraft(null);
    } catch (cause) {
      // The form stays open with its values so the user can correct them.
      setError(schedulingError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(block: WorkBlock) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await deleteWorkBlock(block.id);
      setBlocks(
        (current) => current?.filter(({ id }) => id !== block.id) ?? [],
      );
      setMessage("Session deleted.");
    } catch (cause) {
      setError(schedulingError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="issue-sessions-heading">
      <h2 id="issue-sessions-heading">Work sessions</h2>
      <p>Time reserved to work on this issue. The due date does not change.</p>
      {blocks === null && !error && <p>Loading sessions…</p>}
      {blocks?.length === 0 && <p>No sessions scheduled.</p>}
      {blocks && blocks.length > 0 && (
        <ul className="calendar-day-list">
          {blocks.map((block) => (
            <li key={block.id} className="calendar-day-item">
              <Link
                to={`/calendar?view=week&date=${block.startLocal.slice(0, 10)}`}
              >
                {describe(block, twelveHour)}
              </Link>
              {block.timeZone !== deviceZone() && <span>{block.timeZone}</span>}
              <button
                type="button"
                className="action"
                onClick={() => edit(block)}
              >
                Edit
                <span className="visually-hidden">
                  {" "}
                  session {describe(block, twelveHour)}
                </span>
              </button>
              <button
                type="button"
                className="action"
                disabled={busy}
                onClick={() => void remove(block)}
              >
                Delete
                <span className="visually-hidden">
                  {" "}
                  session {describe(block, twelveHour)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {draft ? (
        <form
          onSubmit={save}
          aria-label={draft.id ? "Edit session" : "New session"}
        >
          <label>
            Date
            <input
              type="date"
              required
              value={draft.date}
              onChange={(event) =>
                setDraft({ ...draft, date: event.target.value })
              }
            />
          </label>
          <label>
            Start
            <input
              type="time"
              required
              value={draft.start}
              onChange={(event) =>
                setDraft({ ...draft, start: event.target.value })
              }
            />
          </label>
          <label>
            End
            <input
              type="time"
              required
              value={draft.end}
              onChange={(event) =>
                setDraft({ ...draft, end: event.target.value })
              }
            />
          </label>
          <button type="submit" className="action" disabled={busy}>
            {draft.id ? "Save session" : "Add session"}
          </button>
          <button
            type="button"
            className="action"
            onClick={() => setDraft(null)}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="action" onClick={() => edit()}>
          Schedule work session
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <p role="status">{message}</p>
    </section>
  );
}
