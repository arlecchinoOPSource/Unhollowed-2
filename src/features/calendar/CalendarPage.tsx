import { useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type { CalendarItem } from "../../database/events";
import { isTauri } from "../../database/status";
import { useLocalToday } from "../today/useLocalToday";
import { CalendarSearch } from "./CalendarSearch";
import { IssueCalendar } from "./IssueCalendar";
import { OverdueIssues } from "./OverdueIssues";
import { ReminderSettings } from "./ReminderSettings";
import { TimelineView } from "./TimelineView";
import { readView } from "./ViewSwitch";
import { monthOf } from "./monthGrid";
import {
  CalendarPreferences,
  PreferenceControls,
  usePreferenceState,
} from "./preferences";
import { defaultSearch, itemDate, type SearchState } from "./searchState";
import { useDeviceZone } from "./useDeviceZone";
import { useEventEditing } from "./useEventEditing";

/**
 * Search above whichever view is shown. It owns the query, so changing view
 * or date keeps it, and it opens results in the shared event editor.
 */
function SearchBar({
  view,
  onChanged,
  revision,
}: {
  view: ReturnType<typeof readView>;
  onChanged: () => void;
  revision: number;
}) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const today = useLocalToday();
  const zone = useDeviceZone();
  const [state, setState] = useState<SearchState>(defaultSearch);
  const [message, setMessage] = useState("");
  const editing = useEventEditing({ onMessage: setMessage, onChanged });

  function open(item: CalendarItem) {
    const date = itemDate(item);
    const next = new URLSearchParams(params);
    next.set("date", date);
    if (view === "month" || view === "agenda") next.set("month", monthOf(date));
    else next.delete("month");
    if (item.kind === "event") {
      // Show the day, then open the event over it.
      setParams(next, { replace: true });
      void editing.openItem(item);
    } else if (item.issueId) {
      // The issue's back link returns to the day the search found.
      navigate(`/issues/${item.issueId}`, {
        state: { from: `${location.pathname}?${next}` },
      });
    }
  }

  return (
    <>
      <CalendarSearch
        state={state}
        onChange={setState}
        calendars={editing.calendars}
        today={today}
        zone={zone}
        revision={revision}
        onOpen={open}
      />
      {editing.error && <p role="alert">{editing.error}</p>}
      {message && <p role="status">{message}</p>}
      {editing.editor}
    </>
  );
}

export function CalendarPage() {
  const [params] = useSearchParams();
  const { settings, save, error } = usePreferenceState();
  const view = readView(params, settings.view);
  // Changing an event elsewhere on the page reloads the view by remounting.
  const [revision, setRevision] = useState(0);
  // Issues changed in the view or the overdue list reload the other.
  const [issueRevision, setIssueRevision] = useState(0);
  return (
    <CalendarPreferences.Provider value={settings}>
      {isTauri() && (
        <SearchBar
          view={view}
          revision={revision}
          onChanged={() => setRevision((value) => value + 1)}
        />
      )}
      {isTauri() && (
        <OverdueIssues
          revision={issueRevision}
          onChanged={() => {
            setIssueRevision((value) => value + 1);
            setRevision((value) => value + 1);
          }}
        />
      )}
      {view === "month" || view === "agenda" ? (
        <IssueCalendar
          key={revision}
          agenda={view === "agenda"}
          onIssueChanged={() => setIssueRevision((value) => value + 1)}
        />
      ) : (
        <TimelineView
          key={revision}
          view={view}
          setIncrement={(increment) => save({ ...settings, increment })}
        />
      )}
      <PreferenceControls current={settings} save={save} error={error} />
      {isTauri() && <ReminderSettings />}
    </CalendarPreferences.Provider>
  );
}
