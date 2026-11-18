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
- **Remembered on this device.** The period (and custom dates) and which sections are shown, in `localStorage` under `unhollowed-2-dashboard` with a version. On read, every field is validated on its own: an unknown preset, an invalid or too-long custom range, an unknown or repeated section, or a different version is replaced by its default without an error.
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
