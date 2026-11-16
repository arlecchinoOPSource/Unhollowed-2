import { useEffect, useState } from "react";
import { localDate, msUntilNextLocalMidnight } from "./dates";

/**
 * Today's local date as YYYY-MM-DD, updated when the local day changes.
 *
 * A timer fires at the next local midnight. Timers can be delayed or skipped
 * while the computer sleeps, and the time zone can change while the app is
 * open, so the date is also checked whenever the window regains focus or
 * becomes visible.
 */
export function useLocalToday(): string {
  const [today, setToday] = useState(() => localDate(new Date()));

  useEffect(() => {
    let timer: number | undefined;
    function schedule() {
      window.clearTimeout(timer);
      // A small margin makes sure the timer lands after midnight.
      timer = window.setTimeout(
        check,
        msUntilNextLocalMidnight(new Date()) + 50,
      );
    }
    function check() {
      setToday(localDate(new Date()));
      schedule();
    }
    function onVisible() {
      if (document.visibilityState === "visible") check();
    }
    schedule();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return today;
}
