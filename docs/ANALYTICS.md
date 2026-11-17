# Workspace analytics

`get_workspace_analytics(from, to, projectId?, timeZone)` is the one read contract behind dashboards and summary cards, so they cannot disagree. It reads authoritative tables for the active workspace and stores or caches nothing. Code: `src-tauri/src/analytics.rs`; TypeScript: `src/database/analytics.ts`.

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
