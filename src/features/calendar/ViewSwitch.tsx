import { useSearchParams } from "react-router";
import { monthOf } from "./monthGrid";
import type { TimelineView } from "./timeline";

export type CalendarView = TimelineView | "month";

const views: [CalendarView, string][] = [
  ["day", "Day"],
  ["week", "Week"],
  ["workweek", "Workweek"],
  ["month", "Month"],
];

/** The calendar view in the URL. Week is the default for a fresh profile. */
export function readView(params: URLSearchParams): CalendarView {
  const view = params.get("view");
  return views.some(([value]) => value === view)
    ? (view as CalendarView)
    : "week";
}

/**
 * Switches between Day, Week, Workweek, and Month, keeping the date in
 * view: timeline views use `date`, and Month uses `month`.
 */
export function ViewSwitch({ date }: { date: string }) {
  const [params, setParams] = useSearchParams();
  const current = readView(params);
  return (
    <div className="calendar-views" role="group" aria-label="Calendar view">
      {views.map(([view, label]) => (
        <button
          key={view}
          type="button"
          aria-pressed={current === view}
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set("view", view);
            if (view === "month") {
              next.set("month", monthOf(date));
              next.delete("date");
            } else {
              next.set("date", date);
              next.delete("month");
            }
            setParams(next);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
