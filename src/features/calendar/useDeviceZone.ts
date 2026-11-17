import { useEffect, useState } from "react";
import { deviceZone } from "../../database/events";

/**
 * The device's IANA time zone, re-read when the window regains focus or
 * becomes visible, since travel or a settings change can move it while the
 * app is open. Calendar reads use it as the viewer's zone, so timed items
 * move to the new local times and date-only items stay on their dates.
 */
export function useDeviceZone(): string {
  const [zone, setZone] = useState(deviceZone);
  useEffect(() => {
    const check = () => setZone(deviceZone());
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return zone;
}

/** `HH:MM` of a UTC instant in `zone`, for showing an item's own zone. */
export function timeIn(instant: string, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}
