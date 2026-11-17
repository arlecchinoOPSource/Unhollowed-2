import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  listCalendars,
  schedulingError,
  type Calendar,
} from "../../database/calendars";
import {
  getEvent,
  type CalendarEvent,
  type CalendarItem,
} from "../../database/events";
import { EventEditor, type EventChange } from "./EventEditor";
import { draftFromEvent, type Draft, type OccurrenceSpan } from "./eventDraft";

const messages: Record<EventChange, (title: string) => string> = {
  created: (title) => `Created event ${title}.`,
  updated: (title) => `Saved event ${title}.`,
  duplicated: (title) => `Duplicated event ${title}.`,
  deleted: (title) => `Deleted event ${title}.`,
};

interface Editing {
  event: CalendarEvent | null;
  occurrence?: { key: string; span: OccurrenceSpan };
  draft?: Draft;
}

/**
 * Opens the shared event editor for a new event or an existing item, and
 * returns focus to whatever opened it. Views render `editor` and reload
 * when `onChanged` runs.
 */
export function useEventEditing({
  onMessage,
  onChanged,
}: {
  onMessage: (message: string) => void;
  onChanged: () => void;
}): {
  calendars: Calendar[];
  defaultCalendar: string;
  error: string;
  openNew: (draft: Draft) => void;
  openItem: (item: CalendarItem, proposed?: OccurrenceSpan) => Promise<void>;
  editor: ReactNode;
} {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [error, setError] = useState("");
  const [request, setRequest] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const latestOpen = useRef(0);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let current = true;
    listCalendars().then(
      (loaded) => {
        if (current) setCalendars(loaded);
      },
      (cause) => {
        if (current) setError(schedulingError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [request]);

  function open(next: Editing) {
    latestOpen.current += 1;
    opener.current = document.activeElement as HTMLElement | null;
    setError("");
    setEditing(next);
  }

  async function openItem(item: CalendarItem, proposed?: OccurrenceSpan) {
    setError("");
    const attempt = ++latestOpen.current;
    try {
      const event = await getEvent(item.eventId ?? item.id);
      if (attempt !== latestOpen.current) return;
      // An occurrence opens with its own times, in the event's zone.
      const span = item.allDay
        ? { start: item.startDate!, end: item.endDate! }
        : { start: item.localStart!, end: item.localEnd! };
      open({
        event,
        draft: proposed
          ? draftFromEvent(event, event.timeZone ?? "UTC", proposed)
          : undefined,
        occurrence: item.occurrence
          ? { key: item.occurrence, span }
          : undefined,
      });
    } catch (cause) {
      if (attempt !== latestOpen.current) return;
      setError(schedulingError(cause));
      onChanged();
    }
  }

  const editor = editing && (
    <EventEditor
      event={editing.event}
      occurrence={editing.occurrence}
      draft={editing.draft}
      calendars={calendars}
      onClose={() => {
        setEditing(null);
        // The opener may have been replaced by a reload.
        requestAnimationFrame(() => {
          if (opener.current?.isConnected) opener.current.focus();
        });
      }}
      onChange={(change, event, note) => {
        onMessage(
          note
            ? `${messages[change](event.title)} ${note}`
            : messages[change](event.title),
        );
        setRequest((value) => value + 1);
        onChanged();
      }}
    />
  );

  return {
    calendars,
    defaultCalendar: calendars.find(({ isDefault }) => isDefault)?.id ?? "",
    error,
    openNew: (draft) => open({ event: null, draft }),
    openItem,
    editor,
  };
}
