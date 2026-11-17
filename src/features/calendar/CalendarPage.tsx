import { useSearchParams } from "react-router";
import { IssueCalendar } from "./IssueCalendar";
import { TimelineView } from "./TimelineView";
import { readView } from "./ViewSwitch";
import {
  CalendarPreferences,
  PreferenceControls,
  usePreferenceState,
} from "./preferences";

export function CalendarPage() {
  const [params] = useSearchParams();
  const { settings, save, error } = usePreferenceState();
  const view = readView(params, settings.view);
  return (
    <CalendarPreferences.Provider value={settings}>
      {view === "month" || view === "agenda" ? (
        <IssueCalendar agenda={view === "agenda"} />
      ) : (
        <TimelineView
          view={view}
          setIncrement={(increment) => save({ ...settings, increment })}
        />
      )}
      <PreferenceControls current={settings} save={save} error={error} />
    </CalendarPreferences.Provider>
  );
}
