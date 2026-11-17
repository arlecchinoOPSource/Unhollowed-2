import { useEffect, useState } from "react";
import { schedulingError } from "../../database/calendars";
import {
  getRemindersEnabled,
  sendTestNotification,
  setRemindersEnabled,
} from "../../database/reminders";

/** What this device's system does with notifications, for the explanation. */
function platform(): "mac" | "windows" | "other" {
  const text = `${navigator.userAgent} ${navigator.platform}`;
  if (/Mac/i.test(text)) return "mac";
  if (/Win/i.test(text)) return "windows";
  return "other";
}

const where = {
  mac: "They appear in Notification Center. macOS may ask for permission the first time. If you declined, allow this app under System Settings, then Notifications. A build run from a terminal can show them under the terminal's name.",
  windows:
    "They appear as Windows notifications. If none show, check Settings, then System, then Notifications, and that Do not disturb or Focus is off.",
  other: "They appear as system notifications.",
};

/**
 * The reminders switch and an honest account of when they fire. The app
 * cannot read the system's notification setting on desktop, so the test
 * button is how to check that notifications reach the user.
 */
export function ReminderSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let current = true;
    getRemindersEnabled().then(
      (value) => current && setEnabled(value),
      (cause) => current && setError(schedulingError(cause)),
    );
    return () => {
      current = false;
    };
  }, []);

  async function toggle(value: boolean) {
    setError("");
    setMessage("");
    try {
      setEnabled(await setRemindersEnabled(value));
      setMessage(value ? "Reminders are on." : "Reminders are off.");
    } catch (cause) {
      setError(schedulingError(cause));
    }
  }

  async function test() {
    setError("");
    setMessage("");
    try {
      await sendTestNotification();
      setMessage(
        "Test notification sent. If you did not see it, check your system notification settings.",
      );
    } catch (cause) {
      setError(schedulingError(cause));
    }
  }

  return (
    <details className="calendar-preferences">
      <summary>Reminders</summary>
      <label>
        <input
          type="checkbox"
          checked={enabled ?? false}
          disabled={enabled === null}
          onChange={(event) => void toggle(event.target.checked)}
        />{" "}
        Show reminders for events
      </label>
      <p>Set a reminder when you edit a timed event. {where[platform()]}</p>
      <p>
        Reminders are shown only while Unhollowed 2 is running, including in the
        background or minimized. When the app is closed nothing is shown, and a
        reminder that came due while it was closed or asleep is skipped once the
        event has started. Reminders are off for all-day events.
      </p>
      <button type="button" className="action" onClick={() => void test()}>
        Send a test notification
      </button>
      {error && <p role="alert">{error}</p>}
      <p role="status">{message}</p>
    </details>
  );
}
