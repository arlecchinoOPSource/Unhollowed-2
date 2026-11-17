# Calendar and scheduling

Phase 3 adds a local scheduling layer to the workspace. This document is the contract for how calendar items are stored, read, and written. `src-tauri/src/scheduling.rs` implements it, and `src-tauri/migrations/0020_scheduling.sql` holds the schema.

## Item kinds

There are three kinds of calendar item. Each has its own storage, so none is a copy of another:

| Kind               | Storage                                                | Time             |
| ------------------ | ------------------------------------------------------ | ---------------- |
| **Event**          | A row in `events`, owned by one calendar               | Timed or all-day |
| **Issue deadline** | None. It is projected from `issues.due_date` when read | Date only        |
| **Work block**     | A row in `work_blocks`, tied to one issue              | Timed            |

- **Deadlines** stay where they are. Rescheduling a deadline changes `issues.due_date` through the existing issue commands, and reading the calendar never creates or changes calendar items. Archived issues are left out. Closed issues are included with `closed: true`, so views can choose whether to show them.
- **Work blocks** schedule time to work on an issue without copying it. Deleting the issue deletes its blocks. Sessions are managed from the issue page, and the timeline shows them apart from deadlines (see Work sessions).
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

### The viewer's zone

Views show timed items in the device's current zone, which they re-read when the window regains focus or becomes visible. So after travel or a settings change, timed items move to the new local times, while all-day events and deadlines keep their dates.

- When an item's own zone differs from the viewer's, the day list shows its time there too, for example "09:00 Asia/Tokyo".
- In the same case, the editor says which zone its times are in.
- New events use the device's zone.

### Time zone rule updates

Governments change daylight-saving rules, and each app release bundles the current IANA database. The wall-clock intent is the source of truth, and the UTC instants are a cache of it:

- `scheduling_state` (migration 21) records, per workspace, the database release the stored instants were resolved with.
- The first calendar read after an update to a different release re-resolves every timed event and work block from its intent in one transaction, then records the release. Reads under the same release skip this, at the cost of one primary-key lookup.
- A changed instant does not touch `updated_at`, because the user did not edit it.
- Unknown zones, and ranges a rule change would invert, are left as stored.

### Recurring times

Recurring timed events (U2-P3-04) repeat their wall-clock time in their own zone. A weekly 09:00 meeting in New York stays at 09:00 New York time across daylight saving, so its UTC instant shifts by an hour. Each occurrence resolves gaps and folds with the same compatible rule. All-day occurrences are dates and never pass through a zone.

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
| `get_event_links`                                     | An event's linked documents and projects, by current name, with an `archived` flag                |
| `link_event_document` / `unlink_event_document`       | Adds or removes a document link. Linking twice changes nothing                                    |
| `link_event_project` / `unlink_event_project`         | The same for projects                                                                             |
| `get_event_reminder` / `set_event_reminder`           | One reminder per timed event, 0 minutes to 1 week before the start, or none                       |
| `get_reminders_enabled` / `set_reminders_enabled`     | The workspace's reminders switch. Reminders are on until turned off                               |
| `claim_due_reminders` / `send_test_notification`      | Delivers reminders that are due, once each, and shows a test notification                         |
| `pick_ics_file` / `export_calendar_ics`               | The native open and save dialogs for calendar files. Both return nothing when canceled            |
| `preview_ics_import` / `import_ics`                   | Reports what a file would add, then adds it in one transaction                                    |
| `update_issue_work_block`                             | Moves or resizes a session. Only its times and zone change                                        |
| `list_issue_work_blocks`                              | An issue's sessions, earliest first, including those of closed and archived issues                |

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

### Recurring events

A recurring event is one `events` row with a repeat rule (migration 22). Occurrences are computed when a window is read, never stored, so an open-ended series costs nothing until it is shown.

- **Rules** follow iCalendar (RFC 5545) `FREQ`, `INTERVAL`, `COUNT`, and `UNTIL`:
  - daily, weekly, monthly, or yearly, every 1–99 units
  - ending never, after 1–999 occurrences, or on a last date (inclusive)
  - weekly repeats the start's weekday
- **Missing days are skipped, not clamped.** Monthly and yearly rules repeat the start's day of the month: a monthly event on the 31st happens only in months with a 31st, and a yearly one on 29 February only in leap years. `COUNT` counts real occurrences.
- **Timed series** repeat their wall-clock start and length in their own zone (see [Recurring times](#recurring-times)). If a daylight-saving gap pushes an occurrence's start past its end, it keeps its scheduled length in elapsed time.
- **Bounded expansion.** Daily and weekly series jump straight to the requested window. Monthly and yearly series step from their start, which is at most twelve steps a year. A safety bound stops any expansion.
- **Occurrence identity.** An occurrence is identified by its original start, `YYYY-MM-DD` or the wall-clock `YYYY-MM-DDTHH:MM` in the event's zone. Items carry it as `occurrence`, with `id` = `{eventId}:{occurrence}`.

Changes to single occurrences are rows in `event_exceptions`, keyed by that original start, so a moved occurrence keeps its identity:

| Command                                                | Effect                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update_event_occurrence`                              | Changes one occurrence's title, text, or time. It stays all-day or timed like its series, in the series' zone and calendar. Only values that differ from the series are stored, so later series edits still reach unchanged fields                                                                                                                                                                                         |
| `cancel_event_occurrence` / `restore_event_occurrence` | Removes one occurrence, or undoes any change to it                                                                                                                                                                                                                                                                                                                                                                         |
| `update_calendar_event`                                | Edits the whole series. Changes to occurrences the edited series no longer has are removed in the same transaction. The editor moves the series' first occurrence by the same amount as the occurrence being edited                                                                                                                                                                                                        |
| `split_event_series`                                   | **This and following.** Ends the series before the occurrence, by its count or with a last date the day before, and starts a new series there with the new values. Later occurrences' changes move to the new series, shifted by the same amount, when it repeats with the same frequency and interval. Otherwise they cannot be matched: they are removed, and `droppedChanges` reports how many so the editor can say so |
| `end_event_series`                                     | **Delete this and following.** From the first occurrence, it deletes the event                                                                                                                                                                                                                                                                                                                                             |

- Duplicating a series copies its rule and its occurrence changes.
- Moved occurrences are re-resolved with everything else when the time-zone rules change.

The editor shows **Apply changes to: This event / This and following events / All events** for occurrences, and the same three choices when deleting. A single occurrence cannot change the repeat, zone, or calendar, so those controls are hidden while **This event** is chosen.

Errors are typed values, such as `invalid_time_zone`, `invalid_date`, `invalid_time`, `invalid_range`, and `range_too_long`, so the UI can say what to fix. Writes run in one transaction. Archived calendars keep their events but accept no new ones.

## Searching

`search_calendar_items({ text, timeZone, today, kinds, calendarIds, includeCompleted })` finds calendar items without a date window. It reads the same tables as `list_calendar_items`, keeps no index or copy of its own, and is scoped to the active workspace, so it cannot return another workspace's items. A calendar ID from another workspace matches nothing.

- **Matching.** `text` is a literal, Unicode case-insensitive substring of an event's title or description, or of an issue's title or description for deadlines and work blocks. `%` and `_` are ordinary characters. Blank text matches everything, which makes the result the list of upcoming items. Text over 200 characters matches nothing.
- **Order.** Results run forward from `today` (a date in `timeZone`), soonest first, then continue backward through earlier items, most recent first. `upcoming` counts the leading items that end on or after `today`. Ties break by end, title, and ID, as in views.
- **Cap.** At most 100 items are returned and `truncated` is set if more matched. Every ordered stream stops after the cap, so the nearest matches are the same however large the history is, and the cost does not grow with it.
- **Filters** combine with AND, and an empty list means none, never all.
  - `kinds`: event, deadline, workBlock. Absent means all.
  - `calendarIds`: limits events to those calendars. Absent means every visible calendar. Deadlines and work blocks belong to issues, so it does not apply to them.
  - `includeCompleted`: includes deadlines and work blocks of done and canceled issues. It is off unless set.
- **Visibility.** As in views, events in hidden or archived calendars and items of archived issues are left out.
- **Recurring events.** A series is never expanded to match. It is one result: its next occurrence within 400 days after `today`, else its latest within 400 days before, else the day the series began. Occurrence changes apply, so a cancelled occurrence is skipped and a moved one is shown where it moved. A series matches on its own title and description, not on text changed for single occurrences. At most 500 matching series are followed.
- **Project filter.** Events and work blocks have no project, so a project filter waits for the sources in U2-P3-11 and U2-P3-13.

The calendar page (`src/features/calendar/CalendarSearch.tsx`) puts **Search calendar** above every view.

- The query and filters live above the views, so changing view or date keeps them. **Clear** resets all of them, and Escape clears the text, then closes the panel.
- Each change cancels the pending search and ignores any reply that arrives after a newer one. Typing waits 200 ms.
- The text field is a combobox. Arrow keys, Home, and End move through results, and Enter opens the chosen one.
- An event opens in the shared event editor over its date. A deadline or work block opens its issue, whose back link returns to the date found.

## Views

`/calendar` opens on **Week** for a fresh profile. **Day**, **Workweek**, and **Month** are one click away, and the view and date are kept in the URL (`?view=day&date=2026-11-18`, or `?view=month&month=2026-11`).

### Day, Week, and Workweek

`src/features/calendar/TimelineView.tsx` draws a vertical timeline for one day, seven days from the week start, or the configured working days.

- **Placement.** Timed items are placed by their start and end on the viewer's wall clock, and clipped to each day they cover. An item continuing from the day before or onto the next shows `…` in place of the hidden time.
  - On a daylight-saving day the grid still has 24 hour rows. The skipped hour stays empty, and both items of a repeated hour share its row.
  - Items shorter than 20 minutes are drawn 20 minutes tall so they stay readable.
- **Overlaps** share the width. Overlapping items form a cluster, and each takes the first column free at its start (`timeline.ts`, unit-tested).
- **The all-day band** shows all-day and multi-day events and open issue deadlines. Each run takes the first free row for the days it covers. In Workweek, a run that crosses a weekend covers only the shown days.
- **Working hours and days** are shaded, the current day is highlighted, and a line marks the current time, updated every 30 seconds.
- **Grid increments** of 15, 30, or 60 minutes come from the **Grid** menu and are remembered on the device.
- **Settings.** The views take a `CalendarSettings` value (`settings.ts`): week start, workweek days, working hours, and grid increment. The defaults are Monday, Monday to Friday, 09:00–17:00, and 30 minutes. Personal preferences (U2-P3-08) can supply it.
- **Editing.**
  - Events are buttons that open the shared event editor, and the editor returns focus to the event when it closes.
  - Work blocks and deadlines link to their issues.
  - Clicking empty time opens a new event there, snapped down to the grid increment. **New event** does the same from the keyboard: at the next increment today, or the start of working hours on another day.
- **Keyboard and screen readers.**
  - Each day is a named group listing its items in time order, so Tab moves through a day's items before the next day's.
  - Item names include the time, title, calendar color, and whether it repeats.
  - The hour grid can take focus, so it can be scrolled from the keyboard even when it is empty.
- **Width.** At narrow window widths, the timeline scrolls sideways inside itself and the page does not.

### Issue deadlines across views

Deadlines come from `issues.due_date` in every view, and no view stores a copy.

- **Overdue** means open and due before the viewer's local today. Closed issues are never overdue. Month chips, the Month day list, and the timeline all-day band mark overdue deadlines in text as well as style.
- **Overdue list.** Every view shows an **Overdue** list above it with open issues due before today, longest overdue first, up to 50. The `project` filter applies. Each row links to the issue and has a date field that reschedules it.
- **Closed issues.** The `closed=1` URL parameter and the **Show closed issues** checkbox include completed and canceled deadlines in Month and in the timeline views. Closed deadlines are drawn struck through.
- **Rescheduling** from Month or the overdue list calls `set_issue_due_date` and changes nothing else. Events and work blocks are never touched. The other views reload afterward, and Issues, Today and Upcoming, and project overview read the same record.
- Timeline deadlines are not filtered by project.

### Work sessions

A work session reserves time to work on one issue. It is a `work_blocks` row of its own, never a deadline or event.

- **Managing.** The issue page lists the issue's sessions with **Schedule work session**, **Edit**, and **Delete**. A session is one day, in the device zone, from a start to a later end. An issue can have any number of sessions, each edited on its own. Sessions may overlap each other and events.
- **Independence.** Creating, moving, or deleting a session never changes the issue's status, due date, or `updated_at`. Moving a session never changes its issue, and a failed move changes nothing.
- **Showing.** Day, Week, and Workweek draw sessions as timed items that link to the issue, labeled "Work block". Deadlines stay in the all-day band.
- **Completed issues** keep their sessions. They stay listed on the issue page, and views mark them closed.
- **Archived issues** keep their sessions, which are hidden from calendar views and search and return when the issue is restored.
- **Permanent deletion** removes the issue's sessions with it. The confirmation lists how many work sessions go. Deletion needs an archived issue, so no visible session disappears without that warning.
- **Standalone focus blocks** (sessions without an issue) are not supported. Each session needs an issue, and `work_blocks.issue_id` is required. An event serves the standalone case.
- Not included: time tracking, analytics, and completing an issue from a session.

### Event links

An event can link to existing documents and projects, so meeting notes and project context open straight from it. The editor shows them under **Documents and projects** for a saved event.

- **Storage.** `event_documents` and `event_projects` hold only an event ID and a target ID, scoped by workspace. Nothing from a document or project is copied, so renaming either keeps the link and the list shows the current name.
- **Ownership.** The event, the target, and the link share one workspace. Commands return `not_found`, `document_not_found`, or `project_not_found` first, and triggers refuse cross-workspace rows written any other way.
- **Duplicates.** A pair links once. Linking again changes nothing.
- **Archived targets** stay linked, are marked "(archived)", and open as usual. The project picker offers only active projects.
- **Repeating events.** Links belong to the event, so every occurrence shares them. Duplicating or splitting a series does not copy links.
- **Removing.** Unlinking deletes only the link row. Deleting an event, document, or project deletes its links and never the other record. A target that is gone simply no longer appears.

### Conflicts and availability

Overlaps are advice only. Nothing is blocked, and overlapping events stay editable and savable. The logic is in `src/features/calendar/intervals.ts`, shared by the timeline, the event editor, and Today.

- **Half-open intervals.** A timed item is `[start, end)` in instants, from `startAt` and `endAt`. Two items overlap when each starts before the other ends. An item that ends when another starts is adjacent and is not a conflict. Instants, not wall-clock text, decide this, so daylight-saving days and items in other zones compare correctly.
- **Which items.** Timed events and work blocks. Repeating occurrences count as the events they are. Items in hidden or archived calendars and of archived issues are never read, so they neither conflict nor block time. Deadlines have no time.
- **All-day policy.** All-day events and deadlines do not conflict and do not reduce free time. They mark the day without occupying hours on it.
- **Timeline.** Overlapping items are outlined with a dashed border, and their accessible names list what they overlap. Each working day's header shows **Free** time: the working-hours window minus the union of timed items, in real elapsed time.
- **Working hours** come from the preferences. The window's ends are wall-clock times resolved in the viewer's zone. A time inside a spring-forward gap resolves to the first moment after the gap, and a repeated time to its first occurrence. A window across a daylight-saving change counts real elapsed hours.
- **Event editor.** While a timed event is drafted, the editor lists the other items it overlaps ("Overlaps X. You can still save."), ignoring the event itself. **Warn when an event overlaps another** in the calendar preferences turns it off on this device.
- Not included: team availability, booking pages, and automatic rescheduling.

### Reminders

A timed event can have one reminder, set under **Reminder** in the editor for a saved event. All-day events have none. Reminders are local: nothing leaves the device.

- **Storage.** `event_reminders` holds an event ID and an offset. `reminder_settings` holds the switch. `reminder_deliveries` records each delivery under the event, the occurrence, the start reminded, and the offset. Deleting an event deletes its rows.
- **When one fires.** The app asks Rust every 30 seconds and when the window regains focus. A reminder is due from `start − offset` until the start (half-open), and a delivery is recorded as it is claimed, so it shows once across repeated checks and restarts. Rust works from stored events, so an edit moves the reminder with the event. Changing the start gives a new delivery identity, so the new time is reminded once more, and a cancelled occurrence or deleted event has nothing due. Each occurrence of a repeating event is reminded separately.
- **Time zones.** Starts are UTC instants resolved from the event's own zone, so reminders follow daylight-saving changes in that zone.
- **Resume.** After sleep, a reminder that came due while the app was asleep still shows if the event has not started. Once it has started the reminder is dropped, and nothing is replayed. Old delivery records are pruned after 48 hours.
- **Delivery.** Rust shows the notification through the Tauri notification plugin, so the webview holds no notification permission. The capabilities file is unchanged.
- **App running required.** Reminders are shown only while Unhollowed 2 is running, including in the background. No background service, login item, or scheduled task is installed, so a closed app shows nothing, on macOS and on Windows.
- **macOS.** Notifications go through Notification Center. macOS asks for permission on first use. If it was declined, allow the app in System Settings, then Notifications. An app run from a terminal can appear under the terminal's name.
- **Windows.** Notifications appear as Windows toasts. They respect Do not disturb and Focus settings. An unpackaged development build may show under a different app name.
- **Permission.** The notification plugin reports permission as granted on desktop, so the app cannot read the system setting. **Send a test notification** under Reminders on the calendar page is how to check. If the system refuses a reminder, a notice says so, and the reminder is not retried.
- **Off.** Turning reminders off silences all of them and records nothing, so turning them on again shows reminders still ahead of their start.
- Not included: cloud or push reminders, all-day reminders, several reminders per event, default reminders, and delivery while the app is closed.

### Calendar files (.ics)

**Import and export** on the calendar page reads and writes iCalendar (RFC 5545) files through the system's open and save dialogs. Everything stays on the device. Only events are exchanged: not deadlines, work blocks, calendars, links, or reminders.

- **Export** writes every event of the workspace, hidden calendars included, as UTF-8 with CRLF line ends, folded at 75 octets, with `PRODID:-//Unhollowed 2//Calendar//EN`. Each event has `UID:{id}@unhollowed-2`, or the UID it was imported with. Timed events use `DTSTART;TZID=<IANA name>` in the event's own zone, UTC events use `Z`, and all-day events use `VALUE=DATE` with an exclusive `DTEND`. A repeating event has `RRULE` (`FREQ`, `INTERVAL`, `COUNT`, or `UNTIL`), cancelled occurrences are `EXDATE`, and a changed occurrence is a second `VEVENT` with the same UID and a `RECURRENCE-ID`. A timed series' `UNTIL` is the end of its last day in the event's zone, in UTC. No `VTIMEZONE` is written, so other apps must know the IANA names.
- **Import** reads `SUMMARY`, `DESCRIPTION`, `LOCATION`, `URL`, `DTSTART`, `DTEND` or `DURATION`, `RRULE`, `EXDATE`, and `RECURRENCE-ID`. Folded lines, text escapes, a byte order mark, and LF line ends are accepted. Times are read with `TZID` (an IANA name), `Z` (UTC), or as floating times in the device's zone. Seconds are dropped, with a note.
- **Preview first.** Choosing a file shows what will be added, what is a duplicate, what is skipped and why, and notes on what was ignored, before anything is stored. The preview runs the import code and rolls it back, so applying matches it. Events go into the calendar chosen in the dialog, or the default.
- **Duplicates.** An event is a duplicate when its UID matches an imported UID or an event's ID in this workspace. A duplicate is skipped and the existing event is not changed, so importing a file twice, or importing this app's own export, adds nothing. There is no update-on-reimport. To change an event, edit it, or delete it and import again.
- **Not imported, with a reason.** An event with no title or start, no end or duration, an end before its start, an unknown time zone, `STATUS:CANCELLED`, an `RRULE` with anything beyond `FREQ`, `INTERVAL`, `COUNT`, and `UNTIL` (such as `BYDAY`), a rule outside the app's limits, or an override whose series is not in the file. The event is skipped whole.
- **Ignored with a note.** Other properties such as `ATTENDEE`, `ORGANIZER`, and `CATEGORIES`, components such as `VTIMEZONE`, `VALARM`, and `VTODO`, an `EXDATE` that is not an occurrence, and a `RANGE=THISANDFUTURE` override. Alarms are not turned into reminders.
- **Atomic.** Events import in one transaction. An event that fails validation is skipped before it is written, and a storage failure rolls back the whole file, so the calendar is never left partly imported. A file over 5 MiB, with more than 2,000 events, or that is not a calendar is refused with a reason and nothing changes.
- The UID of an imported event is kept in `events.ics_uid` (migration 0025), unique per workspace.
- Not included: Google or Microsoft sync, invitations, subscriptions to calendar URLs, and updating events from a newer file.

### Keyboard and accessibility

The calendar works without a pointer. **Keyboard shortcuts** at the foot of the calendar page lists them, and `src/features/calendar/calendarKeyboard.ts` defines them.

| Keys (Alt/Option + Shift +) | Action                                         |
| --------------------------- | ---------------------------------------------- |
| `T`                         | Go to today, keeping the view                  |
| `,` and `.`                 | Previous and next day, week, or month, by view |
| `1` to `5`                  | Day, Week, Workweek, Month, Agenda             |
| `G`                         | Focus **Go to date**                           |
| `S`                         | Open and focus calendar search                 |
| `E`                         | New event                                      |

- **No collisions.** Calendar shortcuts use the same Alt/Option + Shift chord as Issues (which owns `N` and `F`), so they never clash with typing, the system, or the browser. The rule is shared (`shortcutAllowed`): shortcuts do nothing while a field, select, or text box has focus, behind a modal dialog, with another modifier, or when held down. They change the URL as the on-screen controls do, and a polite status announces a changed view or **Today**.
- **Moving between events.** In Day, Week, and Workweek, Up and Down move between the items of a day, Home and End jump to the first and last, and Left and Right go to the nearest neighboring day with items. Month keeps its arrow, Home, End, and Page Up and Down day navigation.
- **Moving an event by keyboard.** With an event focused, Alt/Option + an arrow proposes moving it one grid step (Up, Down) or one day (Left, Right), and Alt/Option + Shift + Up or Down proposes a different end. A proposal opens the editor with the new times, like a drag does, so nothing changes until it is saved. A proposal that cannot be scheduled says so.
- **Open and dismiss.** Enter opens the focused event. The editor is a modal dialog: focus stays inside it, Escape closes it, and focus returns to what opened it. A stale close can no longer end a newer dialog.
- **Not by color alone.** Each item type has a mark besides its color: deadlines have a flag and a dashed edge, work blocks a timer, repeating events a repeat symbol, overlapping items a dashed outline, and every item's name states its type. Closed items are struck through and say so.
- **Motion** follows the system's reduced-motion setting, and focus uses the shared focus ring.
- **Checks.** The browser tests run axe (WCAG 2.2 AA) in light and dark mode on every calendar view and on the timeline with its panels open, a saved event's editor, and the Today schedule, and check that every control shows focus. Screen reader behavior (VoiceOver on macOS, Narrator or NVDA on Windows) is not covered by automated tests and needs a manual pass.

### Calendar libraries

The bundled FullCalendar packages were evaluated and not used. FullCalendar injects its styles at run time, which the production CSP (`style-src 'self'`) blocks, and its time grid does not match the keyboard and focus behavior above. The month grid and the timeline are built on the shared theme tokens instead, with offline layout code that has unit tests.
