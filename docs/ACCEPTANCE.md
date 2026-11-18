# Projects & Issues acceptance

## Reproduce

From the repository root, use the pinned Node and Rust versions and run:

```sh
npm ci
npx playwright install chromium
npm run test:mac
npm run test:browser
```

On Windows, use the equivalent frontend and Rust commands in [Development](DEVELOPMENT.md). Build the desktop application and follow the manual steps below. Use a dedicated test app identifier and a disposable database. Never point a test run at your everyday workspace.

The new SQLite journeys also run with `cargo test --locked --manifest-path src-tauri/Cargo.toml acceptance_tests` after the frontend build. One creates a current-schema database. The other starts at migration 5 with a project, an issue, and a formatted document, applies the remaining migrations, and checks the original record IDs and document content. Both close and reopen the database during the workflow.

## Results

Run on Apple Silicon macOS 26.5.1. The Rust journeys use real SQLite and application persistence functions. Chromium exercises the UI with mocked Tauri IPC. Native smoke uses the packaged Tauri app and its own SQLite file.

| Scenario                                 | Reproduce and expected result                                                                                                                                      | Observed result                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Projects and issues                      | Create and edit a project and an issue. Verify the updated text and stable issue key after revisiting.                                                             | Pass in Chromium. Issue edit and ID persistence also passed in both SQLite journeys.           |
| Labels, milestones, and lifecycle        | Assign a label and milestone, complete the issue, reopen it, and verify the milestone and dashboard counts.                                                        | Pass in Chromium and both SQLite journeys.                                                     |
| Relationships and linked documents       | Add a sub-issue. Link a formatted document to the issue and project. Open the links and verify text and formatting survive.                                        | Pass in Chromium and both SQLite journeys.                                                     |
| Filters, saved views, and flexible views | Filter by project and label, save the query, reopen the saved view, switch list and board, and check date-based views.                                             | Pass in Chromium. Saved configuration persisted in both SQLite journeys.                       |
| Archive and restore                      | Archive a linked issue, reopen the database, restore the issue, and verify its metadata and links.                                                                 | Pass in Chromium and both SQLite journeys.                                                     |
| Dashboard                                | Compare open, closed, and milestone counts after completion, reopening, and restoring.                                                                             | Pass in Chromium and both SQLite journeys.                                                     |
| Upgrade and workspace isolation          | Apply current migrations to the disposable older fixture. Verify the existing document, issue and project ownership, and attempt reads from a different workspace. | Pass in the SQLite journeys. Native UI upgrade untested.                                       |
| Native macOS relaunch                    | From the isolated packaged app, open Issues, create a test issue, quit the application fully, reopen it, and find the same issue and key.                          | Pass. The packaged app showed the same ISS-1 before and after restart.                         |
| Native Windows x64                       | Repeat the native journey with a disposable workspace and record startup, linked content, upgrade, and restart.                                                    | Untested here. Tracked in [#53](https://github.com/arlecchinoOPSource/Unhollowed-2/issues/53). |

The macOS checks passed with 28 frontend and 106 Rust tests. Chromium passed 43 tests. Two Rust benchmarks and two Chromium performance tests were skipped under the regular test commands. The large-workspace relationship picker gap remains tracked in [#52](https://github.com/arlecchinoOPSource/Unhollowed-2/issues/52).

## Beta productivity workflow (U2-P6-09)

Commit `e76fc3a` plus this change, macOS arm64. The journey is `src-tauri/src/beta_workflow.rs`, run with `cargo test --locked beta_workflow`. It uses a real SQLite file and the same functions the Tauri commands call. Nothing is mocked. It is a persistence and data-flow test, not a test of the desktop window.

| Step | Required action                        | Automated result                                                                                                                                                                                                              |
| ---- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Create a project                       | Pass                                                                                                                                                                                                                          |
| 2    | Create issues                          | Pass (3 issues)                                                                                                                                                                                                               |
| 3    | Priorities and milestones              | Pass (high, urgent, low; all three in one milestone)                                                                                                                                                                          |
| 4-5  | Create a document and apply formatting | Pass (heading, bold, italic stored as document JSON, read back byte for byte)                                                                                                                                                 |
| 6    | Link the document to the project       | Pass (also linked to an issue)                                                                                                                                                                                                |
| 7    | Schedule work                          | Pass (a 90-minute work block on an issue)                                                                                                                                                                                     |
| 8    | Recurring events                       | Pass (daily, 5 occurrences; the dashboard counts at least 5 for the week)                                                                                                                                                     |
| 9-10 | Habit and completions                  | Pass (2 completions)                                                                                                                                                                                                          |
| 11   | Mood check-in                          | Pass (1 day recorded)                                                                                                                                                                                                         |
| 12   | Complete project issues                | Pass (2 of 3 done; 1 open)                                                                                                                                                                                                    |
| 13   | Dashboard updates                      | Pass. The dashboard value changes after the completions and shows open 1, due 3, due completed 2, habits completed 2, mood days 1, work blocks 1, open milestones 1.                                                          |
| 14   | Restart                                | The database is closed and opened again from disk, and the migrations run again.                                                                                                                                              |
| 15   | Workspace intact                       | Pass. The whole dashboard is identical, issue ids, status, priority, and milestone are identical, the document text is identical, project and issue links hold, `integrity_check` is `ok`, and no table gained or lost a row. |

Related coverage that already existed: `acceptance_tests` (projects and issues), `phase4_journey` (documents and calendar), `phase5_journey` and `phase5_acceptance` (dashboards), `habits` and `checkins` upgrade tests, and the Chromium specs for each page.

### Not covered, for a person to run on the packaged app

The 15 steps through the real window, on macOS and Windows, with a fresh data folder, and then quit and relaunch the app (never use your everyday workspace):

1. Create a project, three issues with different priorities, and a milestone assigned to them.
2. Create a document, apply heading, bold, and italic, and link it to the project.
3. Schedule a work block and a daily recurring event.
4. Add a habit and check it on two days. Record a mood check-in.
5. Complete two issues. Open the dashboard and compare the numbers with what you did.
6. Quit with Cmd+Q (macOS) or by closing the window (Windows), relaunch, and confirm everything above is unchanged.

Result: not run in this change. No native window was driven.

## Calendar, habits, mood, and dashboards (U2-P6-11)

Commit `e76fc3a` plus this change, macOS arm64. "Browser" means Chromium against mocked IPC, "Database" means real SQLite files, "Unit" means Vitest. The new Database tests are in `src-tauri/src/calendar_regression.rs`.

| Scope item                                  | Layer and evidence                                                                                                                                                                                                                                        | Result |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Day, week, month, agenda views              | Unit: `timeline`, `monthGrid`, `agenda` (grid shape, same grid in every time zone, DST months, overlaps); Browser `calendar.spec.ts` (multi-day events from Month and Agenda, deep links, preferences)                                                    | Pass   |
| Event create, edit, duplicate, move, delete | Browser `calendar.spec.ts`: "creates, edits, duplicates, moves, and deletes events in the editor"; failed writes keep the entered values                                                                                                                  | Pass   |
| Recurring events                            | Browser: "repeats an event and edits one occurrence, this and following, or all", "moves a recurring all-day event..."; Database `scheduling/recurrence` tests                                                                                            | Pass   |
| Time-zone behavior                          | Browser: "shows events from another zone at the viewer's time"; Unit `deviceZone`; **new Database test**: a daily 09:00 Paris event across the Oct 25 clock change stays 09:00 in Paris and reads 03:00 then 04:00 in New York, identical after a restart | Pass   |
| Issue deadlines, scheduled work blocks      | Database `scheduling/tests.rs` (deadlines projected without copies, upgrade keeps them), `phase5_journey`; **new Database test**: a deadline set before migration 26 is still on the calendar after upgrade                                               | Pass   |
| Habit grid and historical completions       | Browser `habits.spec.ts`, `habitHistory.spec.ts` (grid, month, year heatmap, leap February, keyboard, failed save keeps the cell); Unit `habitGrid`                                                                                                       | Pass   |
| Habit archive and restore                   | Browser `habitManager.spec.ts` ("archives and restores a habit with its history intact"); **new Database test**: history is the same list before archive, while archived, after restore, and after a restart                                              | Pass   |
| Mood records                                | Browser `mood.spec.ts`, `moodTrends.spec.ts`; Database `checkins/tests.rs` ("check-ins survive an upgrade and a restart"); **new Database test**: three check-ins and the mood analytics are identical after a restart                                    | Pass   |
| Analytics consistency                       | Database `phase5_acceptance` (upgrade, restart, recomputed analytics), `beta_workflow`; **new Database test**: dashboard analytics value for habits and mood is identical after archive, restore, and restart                                             | Pass   |
| Dashboard widget persistence                | Browser `dashboardGrid.spec.ts` (layout and added widget survive a restart, failed save keeps the last layout), `dashboardControls.spec.ts`; Database `phase5_acceptance` (layouts survive an upgrade)                                                    | Pass   |
| Cross-feature navigation                    | Browser `home.spec.ts` (Home to issue to document and back), `dashboardHome.spec.ts` (each card links to its source), `habitHistory.spec.ts` (history link lands on habit and date)                                                                       | Pass   |
| Restarts and migration upgrades             | Database: every new test closes and reopens the file, and the upgrade test starts at migration 25; `integrity_tests` covers all 24 steps from migration 5                                                                                                 | Pass   |

Not covered: a native window run on macOS or Windows, devices whose time zone changes while the app is open (the browser spec simulates the change), and calendars with tens of thousands of events beyond the timing fixtures in [Performance](PERFORMANCE.md).
