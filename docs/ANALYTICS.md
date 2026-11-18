# Workspace analytics

`get_workspace_analytics(from, to, projectId?, timeZone)` is the one read contract behind dashboards and summary cards, so they cannot disagree. It reads authoritative tables for the active workspace and stores or caches nothing. Code: `src-tauri/src/analytics.rs`; TypeScript: `src/database/analytics.ts`. [Metric and integration contracts](METRICS.md) audits every metric across modules and lists known conflicts.

## Request

| Field        | Meaning                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to` | Local calendar days, `YYYY-MM-DD`, **inclusive**. `from` is on or before `to`, the period is at most **366 days**, years from 1900. |
| `projectId`  | Optional. Must be a project of this workspace, or the call fails with `not_found`.                                                  |
| `timeZone`   | An IANA zone, normally the device's. It turns local days into instants.                                                             |

Today is the device's local date, read in Rust. Errors are `{ code }` values: `invalid_date`, `invalid_range`, `invalid_time_zone`, `not_found`, `database_unavailable`, `workspace_read_failed`, `storage_failed`. Nothing is partially returned on an error.

## Boundaries and semantics

- **Local days.** A timestamp stored in UTC (`created_at`, `completed_at`) counts in the period when it falls between the start of `from` and the start of the day after `to` in `timeZone`. 23:30Z on 30 November is 1 December in Paris. Comparisons use whole seconds. Dates stored as local days (`due_date`, `target_date`) compare as text.
- **Missing versus zero.** A count is `0` when the source answered and nothing matched. A rate (`…Percent`) is `null` when its denominator is `0`. A source that does not apply is `not_applicable` with `data: null` and a reason, never zeros.
- **Archived issues** are never counted. Canceled issues count in no due or completion rate.
- **Sections** each carry `availability`, `reason`, and `data`, so a card can tell "none" from "does not apply".

## Filters

`projectId` limits issues, the project, its objectives and milestones, and the calendar to that project (events linked to it, work blocks on its issues). Habits and check-ins belong to no project, so under a project filter they are `not_applicable` instead of shown unfiltered. A workspace-level milestone (no project) is excluded by a project filter.

## Formulas

| Section    | Field                                                     | Formula                                                                                                                                                            |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| issues     | `created`                                                 | Issues created in the period                                                                                                                                       |
|            | `completed`                                               | Issues with status `done` whose `completed_at` is in the period                                                                                                    |
|            | `due`, `dueCompleted`                                     | Not canceled and due in the period; of those, `done`                                                                                                               |
|            | `duePercent`                                              | `dueCompleted / due × 100`, or `null`                                                                                                                              |
|            | `open`, `overdue`                                         | As of today: not `done` or `canceled`; and of those due before today                                                                                               |
| projects   | `planned`…`archived`                                      | Projects by status, as of today                                                                                                                                    |
|            | `targetInPeriod`, `targetCompleted`                       | Not archived with a target date in the period; of those, `completed`                                                                                               |
|            | `overdue`                                                 | `planned`, `active`, or `on_hold` with a target date before today                                                                                                  |
| objectives | `objectives`                                              | Objectives of the project(s)                                                                                                                                       |
|            | `linkedIssues`, `linkedDone`, `donePercent`               | Distinct linked issues that are not canceled or archived; of those `done`; their ratio, or `null`                                                                  |
| milestones | `open`                                                    | Milestones in `open` state as of today                                                                                                                             |
|            | `dueInPeriod`, `closedOfDue`                              | Due in the period; of those, `closed`                                                                                                                              |
|            | `overdue`                                                 | `open` with a due date before today                                                                                                                                |
| calendar   | `events`                                                  | Event occurrences overlapping the period, from the calendar's own recurrence expansion (`all-day` plus `timed`)                                                    |
|            | `scheduledMinutes`, `workBlockMinutes`                    | Whole minutes of the timed occurrences and of work blocks, counted in full when they overlap the period                                                            |
|            | `workBlocks`                                              | Work blocks overlapping the period                                                                                                                                 |
|            | `truncated`                                               | The calendar returned its maximum of 2000 items, so these are lower bounds                                                                                         |
| habits     | `eligible`, `completed`, `percent`, `practice`            | The habit statistics summary and practice streak for the period ([HABITS.md](HABITS.md), "Statistics")                                                             |
| mood       | `daysRecorded`, `daysInPeriod`, `mood`, `energy`, `focus` | The check-in analytics for the period: each average uses only the days that rated it, with its sample count ([DATA_MODEL.md](DATA_MODEL.md), "Check-in analytics") |

Habits and mood call the engines that own their formulas; they are not recomputed here.

## Size and cost

Each source is one aggregate query over indexed workspace columns, so cost follows the size of the period, not the number of fields requested. A test reads 5000 issues in one pass.

## Keeping views current

Mounted views refresh from a small client-side signal, `src/database/dataChanges.ts`. It is not a datastore: no values are cached or copied, only a version number per source.

- **Publishing.** The database wrappers import `invoke` from `dataChanges`, which resolves exactly as Tauri's does and, only after a write has succeeded (SQLite has committed), publishes the sources that write can affect. `MUTATIONS` lists every writing command and its sources; reads never publish. A failed write publishes nothing, so no view refreshes or claims freshness for a change that did not happen.
- **Sources.** `habits`, `checkins`, `issues`, `projects`, `milestones`, `calendar`. A write names every source it can change: completing an issue wakes issues, projects, and milestones, since objectives and milestone progress derive from it.
- **Reading.** A view calls `useDataVersion(...sources)` and puts the result in its effect dependencies, so it reads again exactly when one of its sources changes. There is no polling and no timer. The habit trends, habit history, mood trends, and Today schedule subscribe; the screens that write (the habit grid, the check-in form) already hold their own state and do not re-read after their own edits.
- **Stale answers.** Each read belongs to one run of its effect. When the period, filter, or sources change, the earlier request is superseded and its answer is ignored whenever it arrives, so a slow older response cannot replace a newer one.
- **Failed reads.** A failed read clears the previous numbers and shows the error with a retry, instead of leaving old values on screen as if they were current.
- **Restart.** Nothing is persisted by this layer. After a restart every number is recomputed from the stored records, and a test confirms the results are identical.

## Progress (U2-P4-17)

`get_progress_analytics(from, to, projectId?, timeZone)` backs **Dashboards > Projects and issues**. It uses the project overview's denominators, so a card and the project screen agree for the same filter. A test compares them field by field.

- **Scope.** Issues that are not archived. Totals, per-project rows, and deadlines are _as of today_; only the trend uses the period.
- **Totals.** `open` is not done or canceled. `completionPercent` is `done / (total − canceled) × 100`, `null` (shown "No issues yet") when that is zero. `overdue` is open and due before today. `upcoming` is open and due from today through the next 6 days, the same window as the issue list's "Due in the next 7 days". `undatedOpen` is open with no due date.
- **Projects.** Every project that is not archived, by name (just the chosen one under a filter), each with its own totals. Milestone completion is the milestone's own state (`closed` of all its milestones) and is never replaced by issue progress. Objective progress is the done share of the objective's linked issues that are not canceled or archived.
- **Deadlines.** Open issues and open milestones that are overdue or due in the next 14 days, by date, at most 20.
- **Trend.** Issues that are `done` now, placed on the local day of their stored `completed_at`: by day for periods up to 92 days, by Monday-to-Sunday week beyond, clipped to the period. A reopened or canceled issue has no completion time and is not counted. A done issue with no stored time (completed before times were kept) cannot be placed, so `withoutTime` of `doneTotal` is reported and the screen says so. Nothing is reconstructed.
- **Click-through.** Counts link to `/issues` with the same `project` filter and the matching `state`, `status`, or `due` preset, so the list shows the cards' own records.
- **Refresh.** The section re-reads when `issues`, `projects`, or `milestones` change (see "Keeping views current").

## Schedule (U2-P4-18)

`get_schedule_analytics(from, to, projectId?, timeZone)` backs **Dashboards > Schedule**. It reads the calendar through its own `list_items`, so recurring events, changed and canceled occurrences, hidden and archived calendars, and archived issues behave exactly as on the calendar and a summary reconciles with the schedule it summarizes. A test compares the totals with the items the calendar returns.

- **Scheduled, not spent.** Minutes are the time the calendar plans. They are never described as time worked, and no score is derived from them.
- **Three kinds, never merged.** _Events_ (timed and all-day), _planned work sessions_ (work blocks on issues), and _due dates_ (open issues due that day) have separate counts everywhere. A closed issue's due date is not an open deadline. Work sessions on closed issues are still scheduled sessions.
- **Local days.** Every timed item is cut at local midnight in `timeZone` and each piece is counted on its own day, so a 23:00 to 01:00 event contributes 60 minutes to each day, and a period holding only the second day counts only that hour. Durations are real elapsed time, so a spring-forward day loses the skipped hour (00:30 to 04:30 on 2026-03-29 in Paris is 180 minutes) and a fall-back day gains it (300 minutes on 2026-10-25).
- **All-day events** cover each day of their dates (end exclusive) inside the period, count once as events, and add **0 minutes**.
- **Overlap.** `eventMinutes` and `workBlockMinutes` sum item lengths, so overlapping items add up. `busyMinutes` is the union of all timed items: time covered once. `overlapMinutes = eventMinutes + workBlockMinutes − busyMinutes`, so nothing is hidden and nothing is counted twice in busy time.
- **Projects.** A work session and a due date belong to their issue's project. An event belongs to the project it is linked to. An event with no link is `unassigned` ("No project"). An event linked to two or more projects is `shared` and counted once, so project lines add up to the totals. Under a project filter, everything tied to that project is kept, shared events included.
- **Period and weeks.** At most 366 days. Weeks run Monday to Sunday, clipped to the period, and add up their days' minutes.
- **Upcoming.** Today through the next 6 days, whatever the period, with the next 10 items in time order, each labeled by kind.
- **Limits.** The calendar lists at most 2000 items per read. When it has more, `truncated` is true and the screen says the counts may be low.

## The workspace dashboard (U2-P4-19)

`/dashboards` composes the sections above under one **period** (last 30, 90, or 365 days) and one optional **project** filter, so every card and chart covers the same days. Each section reads on its own and has its own loading, empty, and error state with a retry, so one failing source never blanks the page.

| Section                 | Source                                                                                                         | Links to                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| At a glance             | `get_workspace_analytics`: open, completed in the period, overdue, habit completion, scheduled events and time | The issue list with the same project and the matching `state`, `status`, or `due` filter; `/habits`; `/calendar` |
| Projects and issues     | `get_progress_analytics`                                                                                       | Issues, projects, deadlines, milestones                                                                          |
| Schedule                | `get_schedule_analytics`                                                                                       | The calendar                                                                                                     |
| Habits                  | `get_habit_statistics`                                                                                         | `/habits`                                                                                                        |
| Mood, energy, and focus | `get_checkin_analytics`                                                                                        | `/mood`                                                                                                          |

- **Availability.** Habits and check-ins belong to no project. With a project selected, the Habits card and section say they are not part of a project, and the mood section is omitted, instead of showing unfiltered numbers. The habit engine is not even asked.
- **Mood is optional.** The mood section appears only when the period has at least one check-in (or when reading failed, to offer a retry). A workspace that does not use check-ins never sees an empty prompt for them.
- **Invalidation.** Sections subscribe to the sources they read (see "Keeping views current"), so a completed habit, issue, or event refreshes the cards that depend on it without reloading the page.
- **Reflow.** Cards use a grid that becomes one column on narrow screens, and wide tables scroll inside their own section so the page itself does not scroll sideways.
- **Not included.** Layout editing, saved layouts, and any combined productivity score.

## Dashboard controls (U2-P4-20)

- **Period.** _Last 7 days_, _Last 30 days_ (the default), _This month_, or _Custom dates_. All are inclusive local days. Last 7 is today and the six days before it; last 30 is today and the 29 before. _This month_ is the whole calendar month (the analytics count through today only). Custom dates need a valid start on or before the end, at most 366 days; otherwise the page says why and keeps showing the last 30 days until the dates are valid. The period applies to every section, and the page states it in full, with its day count.
- **Filters.** _Project_ narrows the issue, project, milestone, and schedule sources. _Habit_ narrows the Habits section to one habit and leaves the workspace-wide cards alone. Habits belong to no project, so choosing a project disables the habit filter. **Clear filters** removes both and returns the period to the default.
- **Filters are not workspace facts.** They are navigation state and name records that can be deleted, so they start empty on every visit and are never saved. Counts keep their definitions; a filter only chooses which records a card reads.
- **Remembered.** The period (and custom dates) and which sections are shown are part of the dashboard's saved layout in the workspace database (see "Dashboard layouts"). Phase 4 kept them in `localStorage` under `unhollowed-2-dashboard`; the first visit copies the supported choices into the saved layout and never reads that key again.
- **Sections.** _Sections_ lists the five sections with a checkbox each; unchecked sections are not rendered or read. _Show all sections_ restores them.
- **Links.** Issue links keep the project filter, and calendar links open the month containing the period's last day.

## Widget registry (U2-P5-02)

`src/features/dashboard/widgets.ts` is the typed table of dashboard widgets. It holds no data and runs no queries: each widget keeps reading its own analytics contract, so a metric means the same wherever it appears ([Metric contracts](METRICS.md)).

- **Types.** `stat-card`, `line-chart`, `bar-chart`, `heatmap`, `issue-list`, `agenda-list`, `project-progress`, `milestone-progress`, `mood-trend`, `notes`, `shortcuts`. A type ID is stored in layouts and never renamed or reused. Types are fixed in code: no scripts, no external plugins.
- **Each type declares** a label, a config `version`, the data `sources` that refresh it (the same names as "Keeping views current"), the dashboard `filters` it honors, a grid size (12 columns, with minimums), empty and error wording, `defaults`, and a `parse` that returns valid config or `null`.
- **Instances.** A placed widget is `{ id, type, version, config? }`. IDs match `^[a-z0-9][a-z0-9-]{0,63}$` and are unique in a layout.
- **Safe fallback.** `resolveWidget` never throws. An unknown type becomes a placeholder and its record is kept. Missing, invalid, or older config falls back to the defaults and says so. Unknown config keys are invalid, so no stored data can smuggle in behavior. Shortcuts accept only in-app paths.
- **Phase 4 sections** are the default layout: `glance` is a `stat-card`, `progress` a `project-progress`, `schedule` an `agenda-list`, `habits` a `heatmap`, and `mood` a `mood-trend`. The IDs equal the saved section keys, so stored preferences keep working. `WidgetHost` renders them with unchanged semantics. Types without a renderer yet show "not available yet".

## Links to records (U2-P5-03)

`src/app/links.ts` builds every in-app link to a source record, on the existing routes. Nothing is shareable outside this device.

| Record              | Path                                           | If the target is gone                                                    |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| Issue               | `/issues/:id`                                  | "Issue unavailable"; archived issues open with their archived banner     |
| Project             | `/projects/:id` (`/issues`, `/goals`)          | The project's own not-found message                                      |
| Document            | `/documents?doc=:id`                           | The editor's own error; a malformed ID says it does not name a document  |
| Habit and day       | `/habits?habit=:id&date=YYYY-MM-DD`            | The habit screen ignores an unknown habit                                |
| Day                 | `/calendar?view=day&date=YYYY-MM-DD`           | Always shows the day                                                     |
| Event or occurrence | `/calendar?view=day&date=YYYY-MM-DD&event=:id` | The day still shows, with the event's not-found message; no editor opens |

- **IDs and dates are checked.** A record ID is a token of letters, digits, hyphens, and underscores (up to 64), so it cannot hold a path, query, or space. Builders throw on a malformed ID or an impossible date. Screens that read an ID from a URL show a plain message instead of calling storage.
- **Workspace scope.** A link carries only an ID. Lookups run in the active workspace, so an ID from another workspace is "not found", exactly like a deleted record.
- **Event links** open the event over its day and then drop `event` from the URL, so closing it, going back, or reloading does not reopen it. For a repeating event, `date` is the occurrence's own date.
- **Back links.** Pages reached from another screen keep that screen's path and filters in navigation state. `safeBack` accepts only in-app paths that start with a single `/`; anything else falls back to the list screen.

## Shared reads (U2-P5-04)

`src/database/sharedQuery.ts` lets several widgets ask the same question without repeating it. It is transient state only: nothing survives a settled read, there is no second store, and no polling.

- **Key.** `queryKey(command, ...args)` sorts object keys and treats `undefined` as `null`, so workspace analytics for the same period, project filter, and time zone always share a key. A different period, project, habit, or zone has a different key and never shares.
- **Sharing.** `sharedRead` joins an identical read already in flight. The entry is removed when the read settles, whether it succeeded or failed, so a retry always asks again and a failure is never replayed later.
- **Invalidation.** A read remembers the versions of the sources it depends on. After a successful write to one of them (`dataChanges.ts`) a new read starts instead of joining the older one, so nobody receives an answer older than a change they just saw. A write to an unrelated source changes nothing.
- **Stale answers.** `useSharedQuery` asks again when its key, its sources, or a retry change. An answer to an earlier question is ignored whenever it arrives. The previous numbers stay until the new answer, with `loading` true.
- **Errors.** A failed read clears the numbers and exposes its message and a retry. Each widget shows its own error, so one failing source does not hide the others.
- **Where it is used.** The five dashboard sections. Before, every widget issued its own read, so two widgets for one scope cost two requests; now they cost one (tested with two mounted widgets).

## Dashboard layouts (U2-P5-05)

A dashboard is a name and a versioned layout, stored in the `dashboards` table (migration `0029_dashboards.sql`) and read and written only through `list_dashboards`, `save_dashboard`, and `delete_dashboard` (`src-tauri/src/dashboards.rs`). It stores no analytics values.

- **Why the database.** Browser storage is per device, not per workspace, and cannot update a layout and its name in one step. A row belongs to one workspace, names are unique per workspace (case-insensitive), and each save is one statement. At most 20 dashboards per workspace.
- **Layout version 1.** `{ version, preferences: { preset, custom: { from, to } }, widgets: [{ id, type, version, config, hidden, x, y, w, h }] }`. IDs and types are lowercase tokens (up to 64), IDs unique. The grid has 12 columns: `1 ≤ w ≤ 12`, `x + w ≤ 12`, `1 ≤ h ≤ 40`, `0 ≤ y ≤ 999`. Config is an object of at most 8 KB. Up to 60 widgets.
- **Writes are strict.** Rust rejects an unknown field, a bad size, a repeated ID, an invalid date or period, or a version other than 1, and stores nothing. Widgets of types this build does not know are accepted and kept.
- **Reads are forgiving.** The stored layout comes back untouched and `readLayout` repairs it: bad period values take their defaults, sizes are clamped to the grid, widgets with unusable or repeated IDs are dropped, and unknown widget types stay as they are. An unreadable record shows the default layout with a note.
- **Newer layouts.** A record with `layout_version` above 1 is returned as written. The page shows the default layout with a note and does not save; Rust also refuses to overwrite it (`newer_layout`), so a downgrade cannot destroy data a newer release wrote.
- **Saving.** Changes apply at once and save one after another, so the last change wins. A failed save keeps the change on screen and says it was not saved.
- **First visit.** With no dashboard, one named "Dashboard" is created from the Phase 4 `localStorage` choices (period and hidden sections, only supported values) or the defaults. The old key is left in place and not read again.
- **Upgrades.** The migration is forward-only and adds one table; a test upgrades a version 28 database and checks existing data is untouched.

## Arranging widgets (U2-P5-06)

`Arrange widgets` on the dashboard opens an editing draft. The committed layout is untouched until **Save layout** succeeds, **Cancel** drops the draft, and a failed save keeps the committed layout and says why.

- **Grid.** 12 columns, rows of at least 2.5 rem that grow with their content. A widget has a column, a row, a width in columns, and a height in rows. Below 900 px the grid is one column in reading order (row, then column); positions are kept for wider windows.
- **Placement rules** (`grid.ts`, used for both display and editing, so they cannot disagree). Sizes and columns are clamped to the grid. The widget being edited keeps the spot it was given. Every other widget, in reading order, goes to the first row where it fits without overlap, and never above a widget that is above it in the same columns, so closing a gap cannot make a widget jump over its neighbors. The result has no overlaps and depends only on the input; settling a settled layout changes nothing. A test applies 300 random moves and resizes and checks that nothing overlaps.
- **Pointer and keyboard.** Each widget in the draft has buttons: Move left, right, up, down, Narrower, Wider, Shorter, Taller. With the widget's frame focused, arrow keys move it and Shift with an arrow resizes it. The new position is announced ("column 7, row 8, 6 columns wide, 4 rows tall"). Nothing requires dragging.
- **Limits.** A widget cannot be narrower or shorter than its type's minimum, wider than the grid, or taller than 40 rows.
- **Not added.** Freehand dragging and a grid library: the buttons and keys cover pointer and keyboard use without a dependency or extra CSP surface.

## Widget library and settings (U2-P5-07)

While arranging, **Add widget** opens the library and each widget has **Settings** and **Remove**. Everything edits the draft; nothing is stored until **Save layout** succeeds.

- **Library.** Lists the types this build can show (those with a renderer) with a description. Types registered but not yet drawable, such as the line chart, are named under "Not available yet" and cannot be added.
- **Preview.** Shows the real widget (`WidgetHost`, with the type's defaults) on the dashboard's current period and filters, so a preview and the saved widget read the same data in the same way. There is no separate preview data path.
- **Adding.** A new instance gets a unique ID (`type-1`, `type-2`, …), the type's default size, the type's defaults, and a place below everything else.
- **Settings are generated from the registry.** Each type lists its `fields`; the form edits exactly those keys. Notes has a text field (up to 2,000 characters). Shortcuts has a choice of places in the app (Home, Today, Calendar, Issues, Projects, Documents, Habits, Mood, Dashboards), up to 12, so a shortcut cannot point anywhere else. Types with no fields say they have no settings.
- **Validation.** The draft is checked with the same `parse` used when a layout is read, so **Apply** is enabled only for settings that would survive a restart; otherwise an alert explains. **Reset to defaults** restores the type's defaults in the form.
- **Removing.** Takes the widget out of the draft; Cancel brings it back, and a removed built-in section can be added again from the library.
- **Focus.** The dialogs are modal. Escape or Close returns focus to the button that opened them.

## Named dashboards and starters (U2-P5-08)

The dashboard page switches between the workspace's dashboards. **Manage dashboards** holds New dashboard, Rename, Duplicate, Make default, Reset layout, Delete, and Arrange widgets.

- **Default.** The default is the dashboard with the lowest `position`; it opens first, and the picker marks it "(default)". Make default moves one to the front in a single transaction (`set_default_dashboard`) and keeps the others' order. A new dashboard goes last, so it never becomes the default by accident.
- **Names** are 1 to 80 characters, unique per workspace ignoring case. At most 20 dashboards.
- **Starters.** General Productivity, Student Workspace, Project Management, and Personal Development (`templates.ts`). A starter is a list of registry widget types with a width and column, turned into the ordinary layout format, then validated and saved like any other dashboard. Each use gets new instance IDs and shares nothing with earlier ones. They use only widgets this build can show. Starters add no separate analytics: widgets read the same sources as always.
- **Duplicate** copies the layout (including widget settings such as notes) with new instance IDs and a new dashboard ID.
- **Delete** asks first and says that the layout is removed, that records are not touched, that it cannot be undone, and what becomes the default. Deleting the open dashboard opens the default. Deleting the only dashboard creates a new General Productivity dashboard, so there is always one to open.
- **Reset layout** asks first and replaces the open dashboard's widgets with the General Productivity starter, keeping its period. Widget settings are lost, and the dialog says so.
- **Newer layouts** cannot be renamed, duplicated, or reset: they are left as the newer release wrote them.
- **Persistence.** Dashboards, their names, layouts, and the default are in the database, so they survive a restart (browser test: create, rename, duplicate, make default, reload).

## Widget periods and filters (U2-P5-09)

The dashboard's controls (period, project, habit) are the globals. Each widget resolves what it uses with `effectiveScope` (`scope.ts`) from its registry capabilities:

- **Period.** A widget whose type supports `period` follows the dashboard's period unless its saved config names its own: `{ "period": { "preset": "last7" | "last30" | "month" | "custom", "custom": { from, to } } }` (`custom` only with the custom preset). It resolves with the dashboard's own rules: inclusive local days, the last 7 days being today and the six before, up to 366 days, and an invalid custom range is not accepted (the widget then falls back to its defaults and says so). Set it under the widget's **Settings > Period for this widget**.
- **Visible.** A widget with its own period shows "Period: Last 7 days (7 days), date to date (this widget's own period)" with **Use dashboard period** to reset it. Widgets that follow the dashboard show nothing extra because the dashboard's period line already applies. A period is never silently mixed: two widgets with different periods each state theirs.
- **Record filters are not stored.** Project and habit filters name records that can be deleted, so they stay transient (see "Dashboard controls"). They apply only to widgets whose type supports them; elsewhere the widget says "The project filter does not apply here" or "The habit filter does not apply here". Sources that do not apply to a filter keep their `not_applicable` meaning inside the widget.
- **Stored vs transient.** The override lives in the widget's config in the saved layout and survives a restart. Filters reset on every visit.

## Charts (U2-P5-10)

`src/components/charts/Chart.tsx` is the one chart for the line and bar widgets. It draws values a query already computed and derives nothing.

- **Widgets.** `line-chart` and `bar-chart` show one measure each, chosen in Settings: _Issues completed_ (progress trend), _Habit completion_ (habit statistics), or _Scheduled time_ (schedule buckets; bars only). Each reads the same shared query as the section for that measure, so the numbers agree. Periods over 92 days use weeks. Under a project filter the habit chart says habits are not part of a project.
- **Range, labels, units.** Every chart names its title, its period, and its units ("5 issues", "1 h 30 min", "80%"). The scale starts at zero; percentages use 0 to 100. The drawing's accessible name gives the range and the highest value.
- **Same values without the picture.** A **Show values** table lists every point for every series, with "No data" where a point has no data. Hover tooltips repeat the same text but nothing depends on hover or color.
- **Missing is not zero.** A point with no data is left out of the drawing (a line breaks there) and says "No data" in the table.
- **Not only color.** Series differ by shape (circle, square, diamond, triangle) and line dash for lines, and by a stripe pattern for bars, in addition to accent.
- **Accents.** Periwinkle, green, amber, and violet tokens (`--series-*`, light and dark). A test checks each is at least 3:1 against the surface of its theme.
- **Empty versus unavailable.** _Empty_ (the source answered and nothing matched) and _unavailable_ (the source does not apply) are different displays with different wording.
- **Motion.** None. Reduced motion needs no override and the stylesheet keeps it that way.
- **Narrow widths.** The drawing scales to its container; the table scrolls inside its own box.

## Comparison (U2-P5-11)

The `comparison` widget shows habit consistency, issues completed, scheduled time, and mood side by side on the same weeks or months. It only aligns and sums what the shared queries already return (`comparison.ts`).

- **Alignment.** Weeks are Monday to Sunday and months are calendar months, both clipped to the period, as the habit and check-in engines cut them. Choose _Group by_ in Settings (default week).
- **Own unit and scale per row.** Habit consistency (percent of eligible habit days, 0 to 100), issues completed (count), scheduled time (minutes, formatted as hours and minutes), and mood (average, 1 to 5). Rows are never put on one axis, indexed, or combined into a score, and the widget says so. Plans (scheduled time) and completed work (issues, habits) stay in separate rows, and scheduled time is never called time worked.
- **Reconciles with its source.** Habit and mood values are the engines' own bucket values. Issue and scheduled-time values are the source's daily buckets summed into the week or month, so each row's total equals the total of the source's buckets for the displayed period. Each row shows its total (or the habit percent for the whole period) beside its coverage.
- **Coverage and sparse data.** Each row states "Data in N of M weeks." A week or month with no source data has no value, which is not zero, and a bucket that starts after today has no data yet. A row with no data at all is the empty display.
- **Where a series cannot be placed.** The progress trend places completions by day up to 92 days and by week beyond. A weekly source cannot be split into months, so for periods over 92 days a monthly comparison says so for that row instead of guessing. Habits and mood are not part of a project, so they are unavailable while a project is selected.
- **Refresh.** All four rows use the shared reads (`queryKey`), the same keys as the sections, so one request serves both and a write refreshes them together.
- **Not included.** Productivity scores, causal claims, inferred project histories.

## Drilldowns (U2-P5-12)

A chart point that has records opens them. The values table under every chart has a **Records** column with a real link per point, so keyboard and screen-reader users follow it with Tab and Enter; clicking a mark does the same. Points with nothing to open have no link.

| Metric            | Opens                                                                              | Cohort                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Issues completed  | `/issues?state=closed&status=done&completedFrom=…&completedTo=…` (and the project) | Done issues, not archived, whose `completed_at` falls on those local days: the trend's own rule                            |
| Scheduled time    | The calendar day (`view=day`), or the agenda from the bucket's first day           | The calendar items of that day. A week or month opens the agenda at its first day, so the agenda's own range may be longer |
| Habit completion  | One habit on the day when a habit is chosen; otherwise the habit grid              | A ratio across habits has no single record list; the chart says so                                                         |
| Mood (comparison) | Nothing                                                                            | An average of ratings, not a list of records; the chart says so                                                            |

- **Exact cohort.** The issue list's `completedFrom` and `completedTo` are local days in the URL and a removable "Completed: …" filter chip. They become UTC instants (the local midnight at the start of the first day and of the day after the last) and the backend compares them with `completed_at` to the second, the same way the trend places a completion, so the list holds the issues the point counted. A test checks the boundary seconds. Half a range, an impossible day, or a reversed range is ignored. Saved views do not store it.
- **Return.** The list shows **Back to the dashboard** (navigation state accepted only for in-app paths), and the browser's Back works too. The period comes back with the dashboard; project and habit filters are transient and start empty again.
- **Removed records.** A drilldown only names days and a project or habit ID. If the project or habit has since been removed, the target screen explains it as it does for any other link.
- **Not fabricated.** Aggregate-only values never list made-up rows.
