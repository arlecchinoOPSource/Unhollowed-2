# Phase 4 verification: Habits, mood, and dashboards

This records the U2-P4-22 validation of Phase 4: what was run, the values it expects, the results, and the platform gaps that remain. The contracts are in [Habits](HABITS.md) and [Analytics](ANALYTICS.md).

## Reproduce

From the repository root, with the pinned Node and Rust versions:

```sh
npm ci
npx playwright install chromium
npm run test:mac
npm run test:browser
cargo test --locked --manifest-path src-tauri/Cargo.toml phase4_journey
npx playwright test phase4 --reporter=line
```

Every Rust test uses an in-memory or temporary file database that is deleted afterward. All habit, mood, and import data is synthetic. Nothing touches a real workspace and nothing needs the network.

## The journey and its expected values

`phase4_journey` (Rust, `src-tauri/src/phase4_journey.rs`) runs the whole phase on two disposable file databases with today fixed at 2026-11-17 in Europe/Paris and the period November 1–30:

| Step                     | What it does                                                                                                     | Expected and asserted                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Upgrade                  | Creates a version 25 database (before habits) with an issue due November 20, then migrates to the latest         | Migrations `0026`–`0028` apply over existing data                                                                       |
| Create, rename, reorder  | Walk, Read, Stretch from November 10. Walk becomes Morning walk. Order Read, Morning walk, Stretch               | Final order Read, Morning walk, Synthetic journal (after the delete and import)                                         |
| Check and navigate       | Walk on 15–17 (17 twice), Read on 10 and 12, Stretch on 11. Read's 11th is checked then unchecked                | Repeated check is safe. 18th refused as future, 9th as before start. Read's history is 10 and 12                        |
| Archive, restore, delete | Archives Stretch, restores it, archives again, then deletes                                                      | Delete refused while active and with a stale revision. Impact shows 1 completion from November 11                       |
| Ember import             | Previews then imports a synthetic Ember backup: Synthetic journal from November 1, done on 3 and 4               | Preview: 1 habit, 2 completions, nothing written. Import applied                                                        |
| Streaks and totals       | Habit statistics for November                                                                                    | 33 eligible days (8 + 8 + 17), 7 completed. Morning walk streak current 3, longest 3                                    |
| Mood                     | Partial check-in today (mood 4). Full historical check-in on the 10th (2, 3, 5, synthetic note)                  | Future day refused. Mood 2 samples, average 3.0. Energy 1 sample, 3.0. Focus 1 sample, 5.0                              |
| Calendar and routine     | Daily 07:00–07:30 routine for 3 days, linked to Morning walk. A 1-hour meeting on the 19th lengthened to 2 hours | 4 timed occurrences, 210 scheduled minutes                                                                              |
| Issue completion         | Dashboard before and after completing the upgraded issue                                                         | Before: 1 open, 1 due, 0 overdue, 0 due completed. After: 0 open, 1 due, 1 due completed                                |
| Dashboard                | Workspace analytics after every change                                                                           | Habits 33 eligible, 7 completed. Mood 2 days recorded                                                                   |
| Backup and export        | JSON backup and CSV history, then a previewed restore into an empty second database                              | Backup holds 3 habits and 7 completions. CSV has 7 rows. Restored names, counts, and streaks are identical              |
| Restart                  | Closes both databases, reopens and migrates them again                                                           | Habit list, statistics, and the whole dashboard equal the values before closing. Routine link and partial check-in kept |

A restore gives habits new IDs, so the restored database is compared by name, counts, and streaks.

## Evidence by workflow

| Workflow                                          | Where it is checked                                                                                                                                                                                         | Result              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| The whole phase with expected values and restart  | `phase4_journey` (Rust, two file databases)                                                                                                                                                                 | Pass                |
| The same flow through the UI                      | `tests/browser/phase4.spec.ts`, light and dark: add and check a habit, partial mood, dashboard refresh on return, period kept after reload (mocked IPC: it checks the UI and its requests, not persistence) | Pass in both themes |
| Migrations and legacy data                        | `habits::schema_tests` and the journey, which migrates version 25 through the latest                                                                                                                        | Pass                |
| Create, rename, reorder, check, history           | `habits::tests`, `habits.spec.ts`, `habitManager.spec.ts`, `habitHistory.spec.ts`, `habitGrid.test.tsx`                                                                                                     | Pass                |
| Archive, restore, delete confirmation             | `habits::tests`, `habitManager.spec.ts`                                                                                                                                                                     | Pass                |
| Streaks and statistics                            | `habits::stats_tests`, `habitDashboard.spec.ts`                                                                                                                                                             | Pass                |
| Ember import                                      | `habits::import_tests` (fixture F2, invalid files, collisions, rollback), `habitImport.spec.ts`                                                                                                             | Pass                |
| Backup, export, restore, undo                     | `habits::backup_tests`, `habitBackup.spec.ts`                                                                                                                                                               | Pass                |
| Partial and historical mood, trends               | `checkins::tests`, `checkins::analytics_tests`, `mood.spec.ts`, `moodTrends.spec.ts`                                                                                                                        | Pass                |
| Charts and heatmaps                               | `habitDashboard.spec.ts`, `moodTrends.spec.ts`, `dashboard.spec.ts` (text equivalents included)                                                                                                             | Pass                |
| Issue completion, calendar changes, agenda        | `analytics::tests`, `analytics::schedule_tests`, `dashboardSchedule.spec.ts`, `agenda.test.tsx`                                                                                                             | Pass                |
| Cross-module refresh                              | `dataChanges.test.tsx`, `dashboardHome.spec.ts`, `phase4.spec.ts`                                                                                                                                           | Pass                |
| Settings and dashboard preferences across restart | `dashboardControls.spec.ts` (period and sections kept, filters reset, bad stored values fall back), `settings.test.tsx`                                                                                     | Pass                |
| Workspace isolation                               | Workspace-scope tests in `habits::tests`, `habits::import_tests`, `checkins::tests`, and `analytics::tests`                                                                                                 | Pass                |
| Themes and keyboard                               | `trackingAccessibility.spec.ts`, `accessibility.spec.ts` (axe in light and dark), keyboard tests in the habit and mood specs                                                                                | Pass                |

## Results

macOS (Apple Silicon): `npm run test:mac` passed with 84 frontend tests and 254 Rust tests (4 ignored benchmarks), including `phase4_journey`. Chromium passed 173 tests, with 5 skipped PERF fixtures, including both themes of `phase4.spec.ts`. Lint, Prettier, and `cargo fmt --check` pass.

No product defect was found. Every expected value in the journey table matched on the first run. The only adjustment was in the test itself: a restore gives habits new IDs, so restored statistics are compared without them.

### Flaky test, stabilized

`habitHistory.spec.ts` › `a history link lands on the habit and date in the checkbox grid` failed once in the first full run and passed alone. Its heading locator matched two headings that both read "February 2028": the grid's month heading and the history panel's heading. The test now scopes to the grid's month navigation. It then passed 10 runs in a row and the full suite passed.

## Platform gaps

| Area                                   | macOS                                 | Windows                               |
| -------------------------------------- | ------------------------------------- | ------------------------------------- |
| Rust and Chromium test suites          | Run (above)                           | Not run here. Quick CI runs on Ubuntu |
| Packaged app launch and restart        | Not run for Phase 4 features          | Not run                               |
| Native backup, export, restore dialogs | Not run                               | Not run                               |
| A real Ember export                    | Synthetic fixtures only, by design    | Same                                  |
| Screen readers                         | VoiceOver not run                     | Narrator and NVDA not run             |
| WebKit and WebView2 rendering          | Automated checks run in Chromium only | Same                                  |

To close the gaps, run `npm run desktop` on each platform against a disposable app identifier and:

1. Add three habits, check several past days, archive and restore one, then delete an archived one after reading the confirmation.
2. Record a mood with only one rating and another for an earlier day.
3. Back up habits to a file, export the history as CSV, then restore the backup and undo the restore. Check that the files open in a text editor and a spreadsheet.
4. Complete an issue and move a calendar event, then open Home and Dashboards and confirm the totals changed.
5. Set a dashboard period and hide a section, quit fully, reopen, and confirm the habits, check-ins, totals, and preferences are unchanged.
6. Walk the habit grid, mood form, and dashboards with VoiceOver or Narrator.
