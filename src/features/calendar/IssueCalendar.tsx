import { newDraft } from "./eventDraft";
import { DatePicker, useCalendarPreferences, validDate } from "./preferences";
import { listCalendarItems, type CalendarItem } from "../../database/events";
import { schedulingError } from "../../database/calendars";
import { RangeEntry, occursOn } from "./CalendarRange";
import { useDeviceZone } from "./useDeviceZone";
import { useEventEditing } from "./useEventEditing";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import {
  createIssue,
  issueError,
  issueKey,
  queryIssues,
  setIssueDueDate,
  type IssueQuery,
  type IssueSummary,
} from "../../database/issues";
import { isTauri } from "../../database/status";
import { StatusBadge } from "../issues/IssueBadges";
import { useIssueReferences } from "../issues/useIssueReferences";
import { addDays } from "../today/dates";
import { useLocalToday } from "../today/useLocalToday";
import { DayEvents } from "./DayEvents";
import { ViewSwitch } from "./ViewSwitch";
import "./timeline.css";
import {
  fullDate,
  gridDays,
  monthOf,
  monthTitle,
  readMonth,
  shiftDateByMonths,
  weekdayNames,
} from "./monthGrid";
import "../issues/issues.css";
import "./calendar.css";

const PAGE_SIZE = 200;
/** Upper bound on issues loaded for one six-week grid. */
const MAX_ISSUES = 1000;
const CHIPS_PER_DAY = 3;
const DRAG_TYPE = "application/x-unhollowed-issue";

interface Loaded {
  key: string;
  issues: IssueSummary[];
  /** True when more than MAX_ISSUES issues fall in the grid. */
  truncated: boolean;
}

/**
 * Dated issues on a month grid. Entries come straight from issue due dates,
 * which are local calendar dates, so an issue appears on the same day in any
 * time zone. Days can be chosen with the mouse or the arrow keys; the chosen
 * day lists every issue due then and can reschedule them or add a new one.
 */
export function IssueCalendar({ agenda = false }: { agenda?: boolean }) {
  const desktop = isTauri();
  const location = useLocation();
  const today = useLocalToday();
  const zone = useDeviceZone();
  const [params, setParams] = useSearchParams();
  const settings = useCalendarPreferences();
  const requested = params.get("date");
  const month = readMonth(
    params.get("month"),
    monthOf(validDate(requested) ? requested : today),
  );
  const project = params.get("project") ?? "";
  const showClosed = params.get("closed") === "1";
  const { projects } = useIssueReferences(desktop);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState("");
  const [request, setRequest] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dropDay, setDropDay] = useState<string | null>(null);
  const dayButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusDay = useRef<string | null>(null);
  const latestMove = useRef(new Map<string, number>());
  const days = gridDays(month, settings.weekStart);
  const first = days[0];
  const last = days[days.length - 1];
  const [eventRevision, refreshEvents] = useState(0);
  const eventKey = JSON.stringify([first, last, zone, eventRevision]);
  const [range, setRange] = useState<{
    key: string;
    items: CalendarItem[];
    truncated?: boolean;
    error?: string;
  }>();
  const editing = useEventEditing({
    onMessage: setMessage,
    onChanged: () => refreshEvents((n) => n + 1),
  });
  useEffect(() => {
    if (!desktop) return;
    let current = true;
    const [start, end, timeZone] = JSON.parse(eventKey) as [
      string,
      string,
      string,
    ];
    listCalendarItems(start, addDays(end, 1), timeZone).then(
      ({ items, truncated }) => {
        if (current)
          setRange({
            key: eventKey,
            items: items.filter((item) => item.kind !== "deadline"),
            truncated,
          });
      },
      (error) => {
        if (current)
          setRange({ key: eventKey, items: [], error: schedulingError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, eventKey]);
  const activeRange = range?.key === eventKey ? range : undefined;
  function eventsOn(date: string) {
    return (activeRange?.items ?? [])
      .filter((item) => occursOn(item, date))
      .sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) ||
          (a.start ?? "").localeCompare(b.start ?? "") ||
          a.title.localeCompare(b.title),
      );
  }
  const key = JSON.stringify({ first, last, project, showClosed, request });

  // The chosen day always belongs to the shown month.
  const day =
    validDate(requested) && monthOf(requested) === month
      ? requested
      : monthOf(today) === month
        ? today
        : `${month}-01`;

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    const {
      first: from,
      last: to,
      project: scope,
      showClosed: closed,
    } = JSON.parse(key);
    const query: IssueQuery = {
      state: closed ? "all" : "open",
      dueAfter: from,
      dueBefore: to,
      undated: "exclude",
      sort: "due",
      direction: "asc",
      ...(scope === "inbox"
        ? { inbox: true }
        : scope
          ? { projectIds: [scope] }
          : {}),
    };
    (async () => {
      const issues: IssueSummary[] = [];
      let total = Infinity;
      while (issues.length < Math.min(total, MAX_ISSUES)) {
        const page = await queryIssues({
          ...query,
          limit: PAGE_SIZE,
          offset: issues.length,
        });
        total = page.total;
        issues.push(...page.issues);
        if (page.issues.length === 0) break;
      }
      return { issues, truncated: total > issues.length };
    })().then(
      (result) => {
        if (current) setLoaded({ key, ...result });
      },
      (cause) => {
        if (current) setLoadError(issueError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, key]);

  // Moving to another month updates the URL a render later, so keep the
  // pending focus until that day's button exists.
  useEffect(() => {
    if (focusDay.current === null) return;
    const button = dayButtons.current.get(focusDay.current);
    if (!button || focusDay.current !== day) return;
    button.focus();
    focusDay.current = null;
  });

  function setParam(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }

  function choose(date: string, focus = false) {
    const next = new URLSearchParams(params);
    next.set("date", date);
    next.set("month", monthOf(date));
    if (focus) {
      focusDay.current = date;
      if (monthOf(date) === month) dayButtons.current.get(date)?.focus();
    }
    setParams(next, { replace: true });
  }

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const weekday = days.indexOf(date) % 7;
    const target =
      event.key === "ArrowLeft"
        ? addDays(date, -1)
        : event.key === "ArrowRight"
          ? addDays(date, 1)
          : event.key === "ArrowUp"
            ? addDays(date, -7)
            : event.key === "ArrowDown"
              ? addDays(date, 7)
              : event.key === "Home"
                ? addDays(date, -weekday)
                : event.key === "End"
                  ? addDays(date, 6 - weekday)
                  : event.key === "PageUp"
                    ? shiftDateByMonths(date, -1)
                    : event.key === "PageDown"
                      ? shiftDateByMonths(date, 1)
                      : null;
    if (!target) return;
    event.preventDefault();
    choose(target, true);
  }

  function setDue(issueId: string, dueDate: string) {
    setLoaded(
      (current) =>
        current && {
          ...current,
          issues: current.issues.map((item) =>
            item.id === issueId ? { ...item, dueDate } : item,
          ),
        },
    );
  }

  // Shown at once, then reconciled. Only the newest move for an issue may
  // change it, so a late reply cannot undo a newer reschedule.
  function reschedule(issue: IssueSummary, dueDate: string) {
    if (!dueDate || dueDate === issue.dueDate) return;
    const number = (latestMove.current.get(issue.id) ?? 0) + 1;
    latestMove.current.set(issue.id, number);
    setError("");
    setMessage("");
    setDue(issue.id, dueDate);
    setIssueDueDate(issue.id, dueDate).then(
      (saved) => {
        if (latestMove.current.get(issue.id) !== number) return;
        setDue(issue.id, saved.dueDate!);
        setMessage(`${issueKey(saved)} is now due ${fullDate(dueDate)}.`);
      },
      (cause) => {
        if (latestMove.current.get(issue.id) !== number) return;
        setDue(issue.id, issue.dueDate!);
        setError(
          `Could not reschedule ${issueKey(issue)}. It is still due ${fullDate(issue.dueDate!)}. ${issueError(cause)}`,
        );
      },
    );
  }

  function drop(event: DragEvent, date: string) {
    event.preventDefault();
    setDropDay(null);
    const id = event.dataTransfer.getData(DRAG_TYPE);
    const issue = loaded?.issues.find((item) => item.id === id);
    if (issue) {
      choose(date);
      reschedule(issue, date);
    }
  }

  if (!desktop) {
    return (
      <section>
        <h1>Calendar</h1>
        <p>Open the desktop app to see your dated issues.</p>
      </section>
    );
  }

  const byDay = new Map<string, IssueSummary[]>();
  for (const issue of loaded?.issues ?? []) {
    if (!issue.dueDate || issue.dueDate < first || issue.dueDate > last)
      continue;
    byDay.set(issue.dueDate, [...(byDay.get(issue.dueDate) ?? []), issue]);
  }
  const from = `${location.pathname}${location.search}`;
  const loading = loaded !== null && loaded.key !== key;
  function orderedNames(style: "short" | "long") {
    const names = weekdayNames(style);
    const offset = (settings.weekStart + 6) % 7;
    return [...names.slice(offset), ...names.slice(0, offset)];
  }
  const shortNames = orderedNames("short");
  const longNames = orderedNames("long");
  const selectedIssues = byDay.get(day) ?? [];
  const createProject =
    project && project !== "inbox" && projects.some(({ id }) => id === project)
      ? project
      : null;

  return (
    <section className="calendar-view">
      <div className="issue-page-top">
        <div>
          <h1>Calendar</h1>
          <p>Issues on the days they are due.</p>
          <Link className="calendar-manage" to="/calendar/calendars">
            Manage calendars
          </Link>
        </div>
        <ViewSwitch date={day} />
        <div className="calendar-filters">
          <label>
            Project
            <select
              value={project}
              onChange={(event) => setParam("project", event.target.value)}
            >
              <option value="">All projects</option>
              <option value="inbox">Inbox (no project)</option>
              {projects
                .filter(
                  ({ id, status }) => status !== "archived" || id === project,
                )
                .map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
          <label className="calendar-check">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(event) =>
                setParam("closed", event.target.checked ? "1" : "")
              }
            />
            Show closed issues
          </label>
        </div>
      </div>
      <div className="calendar-nav">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => choose(shiftDateByMonths(day, -1))}
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <h2 id="calendar-month" aria-live="polite">
          {monthTitle(month)}
        </h2>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => choose(shiftDateByMonths(day, 1))}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="calendar-today"
          onClick={() => choose(today, true)}
        >
          Today
        </button>
        <DatePicker date={day} month />
      </div>
      {error && <p role="alert">{error}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>
      {loadError && (
        <div role="alert">
          <p>{loadError}</p>
          <button
            className="action"
            onClick={() => {
              setLoadError("");
              setRequest(request + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {loaded?.truncated && (
        <p role="note">
          Only the first {MAX_ISSUES} issues in these weeks are shown. Filter by
          project to see the rest.
        </p>
      )}
      {(activeRange?.error || editing.error) && (
        <p role="alert">{activeRange?.error || editing.error}</p>
      )}
      {activeRange?.truncated && (
        <p role="status">
          Some scheduled items are hidden. Choose a shorter view.
        </p>
      )}
      {!activeRange && <p role="status">Loading scheduled items…</p>}
      <div className="calendar-layout">
        {agenda ? (
          <div aria-label="Agenda">
            {days
              .filter(
                (date) =>
                  monthOf(date) === month &&
                  (byDay.has(date) || eventsOn(date).length),
              )
              .map((date) => (
                <section key={date}>
                  <h3>
                    <button type="button" onClick={() => choose(date)}>
                      {fullDate(date)}
                    </button>
                  </h3>
                  <ul>
                    {eventsOn(date).map((item) => (
                      <li key={item.id}>
                        <RangeEntry
                          item={item}
                          day={date}
                          from={from}
                          open={editing.openItem}
                        />
                      </li>
                    ))}
                    {(byDay.get(date) ?? []).map((issue) => (
                      <li key={issue.id}>
                        <Link to={`/issues/${issue.id}`} state={{ from }}>
                          Due · {issue.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            {activeRange &&
              loaded &&
              !days.some(
                (date) =>
                  monthOf(date) === month &&
                  (byDay.has(date) || eventsOn(date).length),
              ) && <p>No scheduled items this month.</p>}
          </div>
        ) : (
          <table
            className="calendar-grid"
            aria-labelledby="calendar-month"
            aria-busy={loaded === null || loading}
          >
            <thead>
              <tr>
                {shortNames.map((name, index) => (
                  <th key={name} scope="col" abbr={longNames[index]}>
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }, (_, week) => (
                <tr key={week}>
                  {days.slice(week * 7, week * 7 + 7).map((date) => {
                    const items = byDay.get(date) ?? [];
                    const scheduled = eventsOn(date);
                    const outside = monthOf(date) !== month;
                    const classes = [
                      "calendar-day",
                      outside && "calendar-outside",
                      date === today && "calendar-is-today",
                      date === day && "calendar-selected",
                      dropDay === date && "calendar-drop",
                    ].filter(Boolean);
                    return (
                      <td
                        key={date}
                        className={classes.join(" ")}
                        onClick={(event) => {
                          if (event.target !== event.currentTarget) return;
                          dayButtons.current.get(date)?.focus();
                          editing.openNew(
                            newDraft(date, zone, editing.defaultCalendar),
                          );
                        }}
                        onDragOver={(event) => {
                          if (!event.dataTransfer.types.includes(DRAG_TYPE))
                            return;
                          event.preventDefault();
                          if (dropDay !== date) setDropDay(date);
                        }}
                        onDragLeave={(event) => {
                          if (
                            !event.currentTarget.contains(
                              event.relatedTarget as Node,
                            )
                          )
                            setDropDay(null);
                        }}
                        onDrop={(event) => drop(event, date)}
                      >
                        <button
                          type="button"
                          className="calendar-date"
                          ref={(element) => {
                            if (element) dayButtons.current.set(date, element);
                            else dayButtons.current.delete(date);
                          }}
                          tabIndex={date === day ? 0 : -1}
                          aria-pressed={date === day}
                          aria-current={date === today ? "date" : undefined}
                          aria-label={`${fullDate(date)}, ${
                            items.length === 1
                              ? "1 issue"
                              : `${items.length} issues`
                          }`}
                          onClick={() => choose(date)}
                          onKeyDown={(event) => moveFocus(event, date)}
                        >
                          {Number(date.slice(8))}
                        </button>
                        {items.length + scheduled.length > 0 && (
                          <ul>
                            {items.slice(0, CHIPS_PER_DAY).map((issue) => (
                              <li
                                key={issue.id}
                                className={`calendar-chip${issue.closed ? " calendar-closed" : ""}`}
                                draggable
                                onDragStart={(event) => {
                                  event.dataTransfer.setData(
                                    DRAG_TYPE,
                                    issue.id,
                                  );
                                  event.dataTransfer.setData(
                                    "text/plain",
                                    issueKey(issue),
                                  );
                                  event.dataTransfer.effectAllowed = "move";
                                }}
                              >
                                <Link
                                  to={`/issues/${issue.id}`}
                                  state={{ from }}
                                  draggable={false}
                                  tabIndex={-1}
                                >
                                  {issue.title}
                                </Link>
                              </li>
                            ))}
                            {scheduled
                              .slice(
                                0,
                                Math.max(0, CHIPS_PER_DAY - items.length),
                              )
                              .map((item) => (
                                <li key={item.id} className="calendar-chip">
                                  <RangeEntry
                                    item={item}
                                    day={date}
                                    from={from}
                                    open={editing.openItem}
                                  />
                                </li>
                              ))}
                            {items.length + scheduled.length >
                              CHIPS_PER_DAY && (
                              <li className="calendar-more">
                                +
                                {items.length +
                                  scheduled.length -
                                  CHIPS_PER_DAY}{" "}
                                more
                              </li>
                            )}
                          </ul>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <section className="calendar-day-panel" aria-labelledby="calendar-day">
          <h2 id="calendar-day">{fullDate(day)}</h2>
          <DayEvents
            day={day}
            onMessage={setMessage}
            revision={eventRevision}
            onChanged={() => refreshEvents((n) => n + 1)}
          />
          {editing.editor}
          <h3>Issues due</h3>
          {loaded === null && !loadError && <p>Loading issues…</p>}
          {loaded && selectedIssues.length === 0 && (
            <p>No issues due this day.</p>
          )}
          {selectedIssues.length > 0 && (
            <ul className="calendar-day-list">
              {selectedIssues.map((issue) => (
                <DayIssue
                  key={issue.id}
                  issue={issue}
                  from={from}
                  onReschedule={(date) => reschedule(issue, date)}
                />
              ))}
            </ul>
          )}
          <NewIssueForm
            date={day}
            projectId={createProject}
            onCreated={(message) => {
              setMessage(message);
              setRequest((value) => value + 1);
            }}
            onError={setError}
          />
        </section>
      </div>
    </section>
  );
}

function DayIssue({
  issue,
  from,
  onReschedule,
}: {
  issue: IssueSummary;
  from: string;
  onReschedule: (date: string) => void;
}) {
  // Commit on Enter or when leaving the field, never while typing.
  const [draft, setDraft] = useState<string | null>(null);
  function commit(event?: { preventDefault(): void }) {
    event?.preventDefault();
    if (draft === null) return;
    const value = draft;
    setDraft(null);
    if (value) onReschedule(value);
  }
  return (
    <li className="calendar-day-item">
      <span className="issue-key">{issueKey(issue)}</span>
      <Link className="issue-title" to={`/issues/${issue.id}`} state={{ from }}>
        {issue.title}
      </Link>
      <StatusBadge status={issue.status} />
      <label>
        <span className="visually-hidden">Due date for {issueKey(issue)}</span>
        <input
          type="date"
          value={draft ?? issue.dueDate ?? ""}
          required
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event);
            if (event.key === "Escape" && draft !== null) {
              event.preventDefault();
              setDraft(null);
            }
          }}
        />
      </label>
    </li>
  );
}

function NewIssueForm({
  date,
  projectId,
  onCreated,
  onError,
}: {
  date: string;
  /** Set when the calendar is filtered to one project. */
  projectId: string | null;
  onCreated: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (saving) return;
    if (!trimmed) {
      onError("Enter an issue title.");
      return;
    }
    setSaving(true);
    try {
      const issue = await createIssue(
        {
          title: trimmed,
          description: null,
          priority: null,
          startDate: null,
          dueDate: date,
        },
        projectId,
      );
      setTitle("");
      onCreated(`Created ${issueKey(issue)}, due ${fullDate(date)}.`);
    } catch (cause) {
      onError(issueError(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="calendar-new" onSubmit={submit}>
      <label htmlFor="calendar-new-title">New issue on this day</label>
      <div>
        <input
          id="calendar-new-title"
          value={title}
          maxLength={200}
          placeholder="Issue title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <button className="action" type="submit" aria-disabled={saving}>
          <Plus size={16} aria-hidden="true" />
          {saving ? "Adding…" : "Add issue"}
        </button>
      </div>
    </form>
  );
}
