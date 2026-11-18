# Metric and integration contracts

This is the Phase 5 audit (U2-P5-01) of how Unhollowed 2 calculates the numbers that dashboards, Home, and module screens show. It records what each measure means today, where two places calculate the same thing, and which Phase 5 issue owns each follow-up. It changes no behavior and adds no analytics engine. The request and boundary rules are in [Analytics](ANALYTICS.md); habit and check-in formulas are in [Habits](HABITS.md) and [Data model](DATA_MODEL.md).

## Rules every metric follows

1. **One owner.** Each measure has one authoritative Rust query. Screens show it and never recompute it. A screen that needs a ratio uses the value the owner returns.
2. **Archived** issues are never counted. Archived habits count only through their archive day. Archived projects appear only in status counts.
3. **Canceled** issues are neither done nor outstanding: they leave every denominator.
4. **Missing is not zero.** A rate is `null` when its denominator is 0. A section that does not apply is `not_applicable`.
5. **Local days.** Dates stored as local days compare as text. UTC timestamps are placed on a local day with the request's `timeZone`.
6. **Snapshot or trend.** A snapshot is "as of today" and cannot be rebuilt for an earlier date. A trend is rebuilt from stored timestamps and states its limits.

## Metric map

| Metric                     | Owner (code)                                        | Formula and denominator                                                                                | Kind                                | Shown by                                  |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------- |
| Open issues                | `analytics::progress::totals`, workspace issues     | Not archived, `closed = 0` (`status` not `done` or `canceled`)                                         | Snapshot                            | Dashboard, project overview               |
| Completion percent         | `progress::totals`; `overview::overview`            | `done ÷ (total − canceled)`; `null` when 0. Progress returns 0–100, overview returns 0–1               | Snapshot                            | Dashboard, project overview               |
| Overdue issues             | `progress::totals`; `overview` `OVERDUE`; workspace | Open and `due_date < today`                                                                            | Snapshot                            | Dashboard, overview, `due=overdue`, Today |
| Upcoming issues            | `progress::totals`; `overview` `UPCOMING`           | Open and due from today through today + 6 days                                                         | Snapshot                            | Dashboard, overview, `due=week`           |
| Issues completed in period | workspace issues                                    | `status = done` and `completed_at` inside the period's local days                                      | Trend (current `done` rows only)    | Dashboard at a glance                     |
| Due in period / done       | workspace issues                                    | Not canceled and due in the period; of those `done`; `duePercent = done ÷ due`                         | Snapshot over a window              | Dashboard at a glance                     |
| Completion trend           | `progress::trend`                                   | Issues `done` now, on the local day (Monday week above 92 days) of `completed_at`                      | Trend; `withoutTime` reported       | Projects and issues section               |
| Objective progress         | `goals::ROLLUP`; `progress::per_project`; workspace | Distinct linked issues, not canceled or archived; `done ÷ that count`                                  | Snapshot                            | Project goals, project rows               |
| Milestone state            | workspace milestones; `progress::per_project`       | Own state `open` or `closed`; never replaced by issue progress. Overdue is `open` and due before today | Snapshot                            | Milestones, dashboard, deadlines          |
| Project status counts      | workspace projects                                  | By `status`, as of today. Overdue is planned, active, or on_hold with `target_date < today`            | Snapshot                            | Dashboard                                 |
| Scheduled minutes          | `analytics::schedule` via calendar `list_items`     | Real elapsed time of timed occurrences cut at local midnight; all-day adds 0                           | Reconstructable (calendar is dated) | Dashboard schedule, at a glance           |
| Busy minutes               | `analytics::schedule`                               | Union of timed items, so overlaps count once                                                           | Reconstructable                     | Dashboard schedule                        |
| Habit completion           | `habits::stats::statistics`                         | `completed ÷ eligible` days, from the habit's start to its archive day, never after today              | Reconstructable from completions    | Dashboard, habits                         |
| Habit streaks              | `habits::stats::streaks`                            | Consecutive completed days; today stays open                                                           | Reconstructable                     | Habits, dashboard                         |
| Mood, energy, focus        | `checkins::analytics::analytics`                    | Mean of the days that rated each field, with its sample count                                          | Reconstructable from check-ins      | Mood trends, dashboard                    |

## Conflicts and risks found

Each item names its evidence and the Phase 5 issue that owns the fix. None changes a stored value.

### C1. Ratios use two units

`overview::overview` returns `completion` as a fraction (`0.5`) and the project screen multiplies by 100 (`ProjectOverview.tsx`, `percent`). `progress::totals` returns `completionPercent` already as 0–100, and habits return `percent` as 0–100. The goals roll-up returns counts and `ProjectGoals.tsx` divides them in the browser.

_Example:_ 1 done of 2 non-canceled issues is `0.5` from the overview and `50` from progress. Both render "50%", but code that reads the two fields by name is off by 100×.

_Owner:_ U2-P5-02 (data-source contracts name the unit) and U2-P5-04 (one percent helper).

### C2. "Today" comes from the system clock, the period from the request

Habits and check-ins read today with `jiff::Zoned::now()` (system zone) in `habits.rs` and `checkins.rs`, and the analytics commands pass that value in, while `timeZone` arrives from the client. They agree when the app's zone is the device's, the normal case, but nothing enforces it.

_Example:_ if the process zone is `Pacific/Auckland` and the request says `Europe/Paris` at 23:30 Paris time, "today" is already tomorrow for habits (one more eligible day) while period boundaries still end on today in Paris.

_Owner:_ U2-P5-04.

### C3. Date arithmetic is copied

`add_days(date, n)` exists in `overview.rs`, `analytics/progress.rs`, and `issues/recurrence.rs`. The calendar has its own typed version in `scheduling/time.rs`. The copies behave the same today, so no value differs, but a fix in one would miss the others.

_Owner:_ U2-P5-04.

### C4. Several "completion" measures

`completionPercent` (all issues as of today), `duePercent` (issues due in the period), "completed in period" (a count by `completed_at`), objective progress, and habit `percent` answer different questions.

_Example:_ in a period where 10 issues are due and 5 are done, `duePercent` is 50, while a project with 100 issues and 90 done has `completionPercent` 90. Both appear on the dashboard.

_Owner:_ U2-P5-02 (each widget declares which measure it shows) and U2-P5-11 (comparison widgets label them).

### C5. Done issues without a completion time

Issues completed before times were stored are `done` with no `completed_at`. The trend reports them as `withoutTime`. "Completed in period" cannot place them and omits them silently.

_Example:_ 40 done issues, 8 without time. The progress card shows 40 done with 8 unplaced, while at a glance "completed in the last 30 days" can count only the 32 with times. The cards differ by design, but only one says why.

_Owner:_ U2-P5-12 (drilldowns show the unplaced records) and U2-P5-13 (insights state the limit).

### C6. Project rows can differ from totals

`progress::totals` counts every non-archived issue in the workspace or filter. `progress::per_project` omits archived projects (`status != 'archived'`) unless filtered to one. Issues of an archived project stay in the totals but have no row.

_Example:_ project A is archived with 3 open issues, so the totals show 3 more open issues than the rows add up to.

_Owner:_ U2-P5-02 (state the rule beside the table) and U2-P5-04 (regression fixture, below).

### C7. Range limits differ by source

Workspace and progress analytics accept at most 366 days, habit statistics 36,600, and check-in ranges fewer than 3,660 (`MAX_RANGE_DAYS`, which rejects at `days >= 3660`).

_Example:_ a 400-day period is valid for the mood analytics but fails the workspace call with `invalid_range`.

_Owner:_ U2-P5-09 (filters pick periods the dashboard can honor) and U2-P5-04.

### C8. Truncation limits

The calendar returns at most 2,000 items per read. Schedule and workspace analytics set `truncated`, and the screen says counts may be low. Deadlines are capped at 20 and upcoming items at 10. A card that hides `truncated` would show a lower bound as a total.

_Owner:_ U2-P5-12 and U2-P5-13.

### Equivalences confirmed (no conflict)

- Overdue is `due_date < today` over open, non-archived issues in `overview`, `progress`, and the workspace section, and in the Today view's `isOverdue`, so issue-list links show the cards' own records.
- `closed` is a generated column (`status IN ('done','canceled')`), so `closed = 0` and "not done or canceled" are the same filter.
- Progress compares `substr(completed_at, 1, 19)` and the workspace section counts whole seconds. Both ignore the sub-second part of the same stored UTC text.
- Objective progress has the same denominator in `goals::ROLLUP` and `progress::per_project`: distinct, not canceled, not archived.

## Current and reconstructable

| Measure                                                         | Reconstructable for a past date?               | Limit                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| Habit completion, streaks, mood averages, scheduled minutes     | Yes, from dated completions, check-ins, events | Habit start and archive days bound eligibility                            |
| Issues completed per day                                        | Partly                                         | Only issues done now; reopened ones leave the trend; times can be missing |
| Open, overdue, upcoming issues; project status; milestone state | No                                             | No status history is stored; show them as "as of today"                   |
| Open count on a past day                                        | No                                             | Never invent it; Phase 5 widgets must not draw such a line                |

## Regression fixtures

| Covered today                                                                                         | Missing, to add with the owner                                             |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `analytics::tests`: boundaries, archived, canceled, null versus zero, project filter, 5000-issue read | Issues of an archived project versus per-project rows (C6), U2-P5-04       |
| `progress` versus `overview` field-by-field comparison                                                | Fraction versus percent unit assertion (C1), U2-P5-02                      |
| `analytics::schedule_tests`: midnight cuts, DST days, overlap, shared events                          | Request `timeZone` different from the process zone (C2), U2-P5-04          |
| `checkins::analytics_tests`, `habits::stats_tests`: eligible days, archive day, future days           | Done issues without `completed_at` in "completed in period" (C5), U2-P5-12 |
| `phase4_journey`: restart reproduces identical values                                                 | A 400-day period across all sources (C7), U2-P5-09                         |

## Worked example

Today is 2026-11-18, UTC. Project A has three issues and project B has two.

| Issue | Status      | Due        | `completed_at`       | Archived |
| ----- | ----------- | ---------- | -------------------- | -------- |
| A-1   | done        | 2026-11-10 | 2026-11-09T22:30:00Z | no       |
| A-2   | todo        | 2026-11-12 | none                 | no       |
| A-3   | canceled    | 2026-11-12 | none                 | no       |
| B-1   | in_progress | 2026-11-20 | none                 | no       |
| B-2   | todo        | none       | none                 | yes      |

- Total (not archived) is 4. Open is A-2 and B-1, so 2. Done is 1. Canceled is 1.
- Completion is 1 ÷ (4 − 1) = 33.3% (overview `0.333`, progress `33.3`, see C1).
- Overdue is A-2 only: A-3 is canceled and A-1 is done. Upcoming through 2026-11-24 is B-1. Undated open is 0 because B-2 is archived.
- Due from 2026-11-01 to 2026-11-18: A-1 and A-2 (A-3 is canceled) is 2, `dueCompleted` is 1, `duePercent` is 50.
- A-1 completed on 9 November at 23:30 in Paris, but on 10 November in `Pacific/Auckland`.

These values come from reading the owner queries above. The repository's tests exercise the same rules with generated records.
