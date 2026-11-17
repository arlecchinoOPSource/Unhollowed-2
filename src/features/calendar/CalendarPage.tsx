import { useSearchParams } from "react-router";
import { IssueCalendar } from "./IssueCalendar";
import { TimelineView } from "./TimelineView";
import { readView } from "./ViewSwitch";

/** `/calendar`: Week by default, or Day, Workweek, or Month. */
export function CalendarPage() {
  const [params] = useSearchParams();
  const view = readView(params);
  return view === "month" ? <IssueCalendar /> : <TimelineView view={view} />;
}
