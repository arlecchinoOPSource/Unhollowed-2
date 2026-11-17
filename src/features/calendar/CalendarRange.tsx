import { displayClock, useCalendarPreferences } from "./preferences";
import { Link } from "react-router";
import { calendarColors } from "../../database/calendars";
import type { CalendarItem } from "../../database/events";
import { addDays } from "../today/dates";
import { swatchStyle } from "../labels/LabelParts";

export function occursOn(item: CalendarItem, date: string) {
  if (item.allDay)
    return (
      !!item.startDate &&
      !!item.endDate &&
      item.startDate <= date &&
      date < item.endDate
    );
  return (
    !!item.start &&
    !!item.end &&
    item.start < addDays(date, 1) + "T00:00" &&
    item.end > date + "T00:00"
  );
}

export function RangeEntry({
  item,
  day,
  from,
  open,
}: {
  item: CalendarItem;
  day: string;
  from: string;
  open: (item: CalendarItem) => void;
}) {
  const { twelveHour } = useCalendarPreferences();
  const time = item.allDay
    ? "All day"
    : item.start?.startsWith(day)
      ? displayClock(item.start.slice(11, 16), twelveHour)
      : "Continues";
  return item.kind === "event" ? (
    <button
      className="calendar-range-event"
      type="button"
      onClick={() => open(item)}
    >
      <span
        className="label-dot"
        aria-hidden="true"
        style={swatchStyle(
          (item.color ?? "gray") as keyof typeof calendarColors,
        )}
      />
      <span>
        {time} · {item.title}
      </span>
    </button>
  ) : (
    <Link to={`/issues/${item.issueId}`} state={{ from }}>
      Work block · {time} · {item.title}
    </Link>
  );
}
