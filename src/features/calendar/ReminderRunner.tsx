import { useEffect, useState } from "react";
import { claimDueReminders } from "../../database/reminders";
import { isTauri } from "../../database/status";

/** How often the app asks Rust which reminders are due. */
const CHECK_MS = 30_000;

/**
 * Delivers due event reminders while the app is open. It checks every half
 * minute and when the window regains focus, which covers resume after sleep.
 * Rust decides what is due and records each delivery, so a reminder shows
 * once however often this asks. If the system refuses a notification, a
 * notice here says so, since the reminder is not retried.
 */
export function ReminderRunner() {
  const [failed, setFailed] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    let running = false;
    async function check() {
      if (running || stopped) return;
      running = true;
      try {
        const run = await claimDueReminders();
        if (!stopped && run.failed > 0)
          setFailed((count) => count + run.failed);
      } catch {
        // The next check tries again.
      } finally {
        running = false;
      }
    }
    void check();
    const timer = window.setInterval(check, CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (failed === 0) return null;
  return (
    <p role="alert" className="reminder-failed">
      {failed === 1
        ? "A reminder could not be shown as a notification."
        : `${failed} reminders could not be shown as notifications.`}{" "}
      Check your system notification settings for this app.{" "}
      <button type="button" onClick={() => setFailed(0)}>
        Dismiss
      </button>
    </p>
  );
}
