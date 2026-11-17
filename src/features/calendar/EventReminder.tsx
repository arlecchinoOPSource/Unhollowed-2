import { useEffect, useState } from "react";
import { schedulingError } from "../../database/calendars";
import {
  getEventReminder,
  reminderOffsets,
  setEventReminder,
} from "../../database/reminders";

/**
 * One reminder for a saved timed event, kept apart from the event itself
 * and applied at once. Editing the event moves the reminder with it, and
 * deleting the event removes it.
 */
export function EventReminder({ eventId }: { eventId: string }) {
  const [minutes, setMinutes] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    getEventReminder(eventId).then(
      (value) => current && setMinutes(value),
      (cause) => current && setError(schedulingError(cause)),
    );
    return () => {
      current = false;
    };
  }, [eventId]);

  async function change(value: string) {
    setError("");
    try {
      setMinutes(
        await setEventReminder(eventId, value === "" ? null : Number(value)),
      );
    } catch (cause) {
      setError(schedulingError(cause));
    }
  }

  return (
    <div>
      <label className="event-field">
        Reminder
        <select
          value={minutes === undefined ? "" : String(minutes ?? "")}
          disabled={minutes === undefined}
          onChange={(event) => void change(event.target.value)}
        >
          <option value="">No reminder</option>
          {reminderOffsets.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p>Shown while the app is running. See Reminders on the calendar page.</p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
