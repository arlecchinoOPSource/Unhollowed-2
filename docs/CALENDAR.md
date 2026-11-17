# Calendar and scheduling

Phase 3 adds a local scheduling layer to the workspace. This document is the contract for how calendar items are stored, read, and written. `src-tauri/src/scheduling.rs` implements it, and `src-tauri/migrations/0020_scheduling.sql` holds the schema.

## Item kinds

There are three kinds of calendar item. Each has its own storage, so none is a copy of another:

| Kind               | Storage                                                | Time             |
| ------------------ | ------------------------------------------------------ | ---------------- |
| **Event**          | A row in `events`, owned by one calendar               | Timed or all-day |
| **Issue deadline** | None. It is projected from `issues.due_date` when read | Date only        |
| **Work block**     | A row in `work_blocks`, tied to one issue              | Timed            |

- **Deadlines** stay where they are. Rescheduling a deadline changes `issues.due_date` through the existing issue commands, and reading the calendar never writes. Archived issues are left out. Closed issues are included with `closed: true`, so views can choose whether to show them.
- **Work blocks** schedule time to work on an issue without copying it. Deleting the issue deletes its blocks. Their editing UI arrives with U2-P3-12.
- **Calendars** group events. Each workspace has exactly one default calendar, enforced by a partial unique index. Rust creates it, named Personal, the first time anything needs it. Events in hidden or archived calendars are stored but left out of calendar reads.

## Ownership

Every calendar, event, and work block belongs to one workspace, and commands act only on the active workspace.

- An event's calendar and a work block's issue must be in the same workspace. Commands check this first and return `calendar_not_found` or `issue_not_found`. Triggers refuse cross-workspace rows written any other way, and a row's workspace cannot change.
- IDs are UUIDs created in Rust and never reused.
- An event's calendar is required. Calendars are archived, not deleted, so events are never orphaned.

## Time

Calendar items use two representations, never mixed in one row.

- **Date-only** (all-day events and deadlines): calendar dates as `YYYY-MM-DD`. They mean the same day in every time zone, and no zone is stored or applied.
- **Timed** (timed events and work blocks): the user's intent and the resolved instants.
  - `time_zone` is an IANA name, such as `Europe/Paris`.
  - `start_local` and `end_local` are wall-clock times in that zone, as `YYYY-MM-DDTHH:MM`.
  - `start_at` and `end_at` are the same moments in UTC, as `YYYY-MM-DDTHH:MM:SSZ`. Their fixed width lets SQLite compare them as text.

Rules:

- **Half-open ranges.** Every range excludes its end. An event from 09:00 to 10:00 does not overlap one from 10:00 to 11:00. An all-day event on 1–2 December is stored as `2026-12-01` to `2026-12-03`. A timed item must end after it starts.
- **Daylight-saving gaps.** A wall-clock time that does not exist, such as 02:30 on the night clocks spring forward, resolves to the same time shifted forward by the gap (03:30).
- **Daylight-saving folds.** A wall-clock time that happens twice, such as 01:30 on the night clocks fall back, resolves to the earlier of the two instants.

  These gap and fold rules are the "compatible" rule of RFC 5545 and JavaScript Temporal. The stored local time keeps what the user entered, and the instant records what it resolved to.

- **Day boundaries.** A day in a zone runs from its first instant to the next day's first instant, so it can last 23 or 25 hours. Where midnight does not exist, the day starts at the first time that does.
- **Time zone database.** The IANA database is bundled with the app (`jiff`), so results are the same on every platform and work offline, whatever zone files the device has.
- **Limits.** One event or work block lasts at most 366 days.

## Reading

`list_calendar_items({ from, to, timeZone })` returns every item that overlaps a window of calendar days in the viewer's zone, with `to` exclusive.

- Timed items carry `start` and `end` as wall-clock times in the viewer's zone, ready to place on a grid. They also carry the instants and their own `timeZone`.
- Date-only items carry `startDate` and an exclusive `endDate`.
- Items are ordered by start, with date-only items before timed ones on the same day. Ties break by end, title, and ID.
- A window covers at most 400 days. At most 2,000 items are returned. If more match, the earliest are returned and `truncated` is set.
- Range reads use the partial indexes `events_timed_range` and `events_dated_range`, and `work_blocks_range`. A test asserts the query plans.

## Writing

| Command                                               | Effect                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `list_calendars`                                      | Calendars of the active workspace, creating the default if needed                                 |
| `create_calendar_event`                               | Creates a timed or all-day event, in the default calendar unless `calendarId` names an active one |
| `get_calendar_event`                                  | One event                                                                                         |
| `create_issue_work_block` / `delete_issue_work_block` | Adds or removes time for an issue                                                                 |

### Managing calendars

| Command                               | Effect                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_calendar` / `update_calendar` | Sets name, color, and description. Names are unique within the workspace, ignoring case. Archived calendars can be edited                            |
| `set_calendar_hidden`                 | Shows or hides a calendar's events in calendar views                                                                                                 |
| `set_default_calendar`                | Makes an active calendar the default. The old default is cleared in the same transaction                                                             |
| `archive_calendar`                    | Keeps every event, hides them from views, and stops new events. Archiving the default needs an active `replacement`, which becomes the default first |
| `restore_calendar`                    | Brings the calendar and its events back                                                                                                              |
| `move_calendar_event`                 | Moves an event to another active calendar. Only `calendar_id` changes, so the event keeps its ID                                                     |

- Calendar settings, including visibility, are stored in the workspace database, so they survive restarts and stay on the device.
- Colors are the label palette. Each color is named in the UI, so color is never the only cue.
- **Calendars** (`/calendar/calendars`, linked from the calendar) manages all of this.

### Editing events

| Command                    | Effect                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update_calendar_event`    | Replaces an event's fields in one transaction. Without `calendarId` it stays in its calendar. A new calendar must be active and in the same workspace |
| `duplicate_calendar_event` | Copies an event, with a new ID, into the same active calendar at the same time                                                                        |
| `delete_calendar_event`    | Permanently deletes an event. The editor asks for confirmation first                                                                                  |

- **Text.** Titles are 1–200 characters, descriptions up to 10,000, and locations up to 200. Blank optional fields are stored as absent.
- **Links.** Only `http` and `https` addresses with a host are accepted, because the app may open them. `javascript:`, `file:`, and other schemes are refused with `invalid_url`.
- **The editor** (`src/features/calendar/EventEditor.tsx`) is shared by every calendar view.
  - Quick fields come first: title, all day, start, and end. Calendar, time zone, location, link, and description are under **More details**.
  - All-day events show an inclusive last day, and the API stores an exclusive end. `eventDraft.ts` converts between the two.
  - A failed save keeps every entered value, and Rust's transaction leaves the saved event unchanged.
  - **Duplicate** opens the copy for editing.
  - **Delete…** asks for confirmation, with focus on the confirming button.
  - Escape or Cancel closes without saving.
- The calendar's day panel lists the selected day's events and has **New event**. The timeline views (U2-P3-06) reuse the same editor.

Errors are typed values, such as `invalid_time_zone`, `invalid_date`, `invalid_time`, `invalid_range`, and `range_too_long`, so the UI can say what to fix. Writes run in one transaction. Archived calendars keep their events but accept no new ones.

Recurrence (U2-P3-04) extends these commands.
