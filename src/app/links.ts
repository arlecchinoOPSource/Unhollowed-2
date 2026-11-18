/**
 * In-app links to source records, in one place. Every builder returns a path
 * for the existing React Router routes; nothing here is shareable outside
 * this device, and a link only ever names a record by its stable ID. The
 * target screen looks the record up in the active workspace, so an ID from
 * another workspace or a deleted record is simply "not found".
 */

/**
 * Record IDs are generated tokens: letters, digits, hyphens, and underscores.
 * Anything with a slash, dot, query, or space cannot name a record or escape
 * its route.
 */
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isRecordId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);

export const isDay = (value: unknown): value is string =>
  typeof value === "string" &&
  DAY.test(value) &&
  value >= "1900-01-01" &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

function need(value: string, ok: boolean, what: string): string {
  if (!ok) throw new Error(`Not a valid ${what}: ${value}`);
  return value;
}

/** A path with query values encoded, skipping unset ones. */
function path(base: string, query: Record<string, string | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") search.set(key, value);
  const text = search.toString();
  return text ? `${base}?${text}` : base;
}

export const links = {
  issue: (id: string) => `/issues/${need(id, isRecordId(id), "issue ID")}`,
  project: (id: string) =>
    `/projects/${need(id, isRecordId(id), "project ID")}`,
  projectIssues: (id: string) =>
    `/projects/${need(id, isRecordId(id), "project ID")}/issues`,
  projectGoals: (id: string) =>
    `/projects/${need(id, isRecordId(id), "project ID")}/goals`,
  document: (id: string) =>
    path("/documents", { doc: need(id, isRecordId(id), "document ID") }),
  habit: (habitId: string, date?: string) =>
    path("/habits", {
      habit: need(habitId, isRecordId(habitId), "habit ID"),
      date: date === undefined ? undefined : need(date, isDay(date), "date"),
    }),
  /** A day, shown in the chosen calendar view. */
  calendar: (date: string, view: "month" | "week" | "day" | "agenda" = "day") =>
    path("/calendar", { view, date: need(date, isDay(date), "date") }),
  /**
   * An event on its day, opened over the calendar. `occurrence` is the
   * occurrence's own date for a repeating event; the day is shown even if the
   * event or that occurrence has since gone.
   */
  event: (eventId: string, date: string, occurrence?: string) =>
    path("/calendar", {
      view: "day",
      date: need(occurrence ?? date, isDay(occurrence ?? date), "date"),
      event: need(eventId, isRecordId(eventId), "event ID"),
    }),
};

/**
 * Where a "back" link may go: an in-app path, never an address elsewhere.
 * Navigation state can be written by anything that links here, so it is
 * checked before it is followed.
 */
export function safeBack(value: unknown, fallback: string): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    value.length <= 500
    ? value
    : fallback;
}

/** The event ID in a calendar URL, or null when absent or malformed. */
export function eventParam(params: URLSearchParams): string | null {
  const value = params.get("event");
  return isRecordId(value) ? value : null;
}
