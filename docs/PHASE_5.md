# Phase 5 verification: Dashboards and Home

This records what was run to verify Phase 5 and what remains. The contracts are in [Analytics](ANALYTICS.md), [Metric contracts](METRICS.md), and [Product](PRODUCT.md). Each section is added by the issue that produced it.

## Workflow continuity (U2-P5-17)

The journey: a deadline on Home, the issue, a planned work session, a linked document, editing it, returning to the same issue, completing it, and seeing the numbers follow.

| Layer                               | Test                                                                                                | What it proves                                                                                                                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database (disposable file, restart) | `phase5_journey::one_issue_document_and_work_session_carry_through_planning_completion_and_restart` | One issue, one document link, and one work session are the same records after completing, reopening, and restarting. Dashboard: open 1 to 0 to 1, due completed 0 to 1 to 0, the planned session stays 1 (60 min); progress totals open 0, done 1, overdue 0 when complete |
| Browser (mocked IPC)                | `home.spec.ts`: the planning-to-completion journey                                                  | Home "Due today" opens the issue (back link says Home), a session is added, the document is linked and opened, the document's back link returns to the same issue URL with the session and link intact, completing the issue removes it from Home                          |
| Browser                             | `home.spec.ts`: a link to a removed document or issue                                               | A missing issue shows "Issue unavailable" with a way back; a missing document shows an alert                                                                                                                                                                               |

- **Return destinations.** Links from Home pass the place to return to; the issue page labels it "Home", "Dashboard", "Calendar", or "Today" and only accepts in-app paths. Documents opened from an issue return to that issue.
- **Refresh.** Every write in the journey goes through the shared command wrapper, so Home and dashboard widgets that read issues, calendar items, or habits re-read after the write commits. A failed write publishes nothing and the previous numbers stay.
- **Gaps.** The browser journey runs against the mocked backend: it checks the UI and navigation, not persistence (the database test covers that). Dashboard numbers are checked in the database test, because the browser mock returns fixed analytics.

## Dashboard accessibility and responsive UI (U2-P5-18)

Run in Chromium against the mocked backend, in light and dark mode, with every widget the library offers added to one dashboard (`tests/browser/dashboardAccessibility.spec.ts`).

| Check                                                                                                                                                                 | How                                                                                                                       | Result |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| Automated WCAG 2.2 AA scan (axe): the full dashboard with charts and every value table open                                                                           | `AxeBuilder`, tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`                                                 | Pass   |
| The same scan in arrange mode, widget settings, the library with a preview, and the New, Rename, Delete, and Reset dialogs                                            | Same                                                                                                                      | Pass   |
| Empty and failed-source states                                                                                                                                        | Same, empty workspace and a failing `get_progress_analytics`                                                              | Pass   |
| Visible focus on every tab stop, in view mode and arrange mode (up to 400 stops)                                                                                      | Outline of at least 2 px or a box shadow on each focused element                                                          | Pass   |
| No sideways scrolling at 620 px (the window's minimum) and 375 px with every widget                                                                                   | Sections, cells, charts, and toolbar stay inside the main area                                                            | Pass   |
| Keyboard only: open the manage menu, arrange, move and resize with arrow keys, add and configure a widget, save, read a chart's table, open a point's records, return | Focus plus Enter, Space, arrows; no pointer                                                                               | Pass   |
| Reduced motion                                                                                                                                                        | Tests run with `prefers-reduced-motion: reduce`; the app stylesheet clamps transitions and the chart stylesheet adds none | Pass   |
| Chart contrast                                                                                                                                                        | Series colors at least 3:1 on each theme's surface (`charts.test.tsx`); axe checks text contrast                          | Pass   |

- **Charts.** Each has an accessible name with title, range, series, and highest value; a **Show values** table with every value; legends that do not rely on color alone (shape, dash, stripe); and distinct empty and unavailable displays.
- **Layout editing.** Every move and resize has a button and an arrow-key equivalent, announced in words. Nothing requires dragging.
- **Density.** Widgets show a bounded number of rows; long tables scroll inside their own box.

### Native gaps

Not verified here, and to be checked on the packaged apps (macOS WKWebView and Windows WebView2):

- Screen reader behavior with VoiceOver and with NVDA or Narrator: the checks above are automated and keyboard-based, not a listening test. In particular, how the chart descriptions, the live announcements while arranging, and the native `<dialog>` focus return sound.
- Focus ring rendering and `<details>` and `<dialog>` behavior in the native web views, which differ slightly from Chromium.
- Windows high-contrast mode and operating-system text scaling at 200%.
- Real pointer and touch input on trackpads and touch screens.

## Dashboard performance, cache correctness, and recovery (U2-P5-19)

Run on Apple M5, macOS 26.5.1. Nothing is cached: authoritative data is read every time, and the only sharing is between identical reads that are in flight at the same moment.

### Backend reads at a heavy workspace

`measure_dashboard` in `src-tauri/src/perf_tests.rs` builds one disposable file database and times each dashboard read (10 runs after a warm-up, release build):

```sh
cargo test --release --manifest-path src-tauri/Cargo.toml measure_dashboard -- --ignored --nocapture
```

Fixture: 5,250 issues in 13 projects (with milestones, an objective, labels, and parent links), 500 events across a year (repeating series, changed and canceled occurrences, reminders and links) with 250 work blocks, 30 habits with 38,241 completions over five years, and 913 check-ins.

| Read                               | 30 days | 366 days |
| ---------------------------------- | ------: | -------: |
| Workspace analytics (all sections) | 75.7 ms |  86.5 ms |
| Workspace analytics, one project   | 12.6 ms |  28.4 ms |
| Progress analytics                 | 18.4 ms |  23.4 ms |
| Schedule analytics                 | 21.6 ms |  59.2 ms |
| Habit statistics                   | 56.7 ms |  52.7 ms |
| Mood analytics                     |  0.1 ms |   0.9 ms |

The reads run in parallel from separate widgets, so the dashboard's backend cost is the slowest read plus contention, not the sum. The workspace read's time is dominated by its habit section (57 of 76 ms), the same statistics the Habits section asks for separately, so a dashboard with both computes habit statistics twice. That duplication is recorded rather than removed here: merging them would change the analytics contract, and 2 × 57 ms is within the one-page budget. It is the first place to look if habit history grows much past five years of 30 habits.

### Requests

`dashboardPerformance.spec.ts` counts the IPC calls a dashboard with nine widgets (the five sections plus a line chart, a bar chart, the comparison, and the insights) sends on load.

| Source              | Widgets that read it | Requests before sharing | Requests now |
| ------------------- | -------------------: | ----------------------: | -----------: |
| Progress analytics  |                    5 |                       5 |            1 |
| Workspace analytics |                    2 |                       2 |            1 |
| Habit statistics    |                    3 |                       3 |            1 |
| Check-in analytics  |                    2 |                       2 |            1 |
| Schedule analytics  |                    3 |                       3 |            2 |
| **Total**           |                      |                  **15** |        **6** |

The schedule is read for the period and, for the insights, for tomorrow. "Before sharing" is one request per reading widget, as the sections did before U2-P5-04.

### Render cost

The opt-in fixture (`PERF=1 npx playwright test dashboardPerformance`) times in-app navigation to a dashboard of nine widgets against the instant mocked backend, so it measures the UI only: median of three runs, **65 ms** until the insights list and the comparison have their content.

### Correctness

| Property                                                | Test                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A write refreshes only what reads its sources           | `a write refreshes only the widgets that read what it changed`: checking a habit on Home re-reads habits once and not issues, projects, or progress                                                                                                       |
| A read begun before a write is not joined after it      | `sharedQuery.test.tsx`                                                                                                                                                                                                                                    |
| An older answer never replaces a newer one              | `sharedQuery.test.tsx`; `rapid period changes leave the dashboard on the last choice`                                                                                                                                                                     |
| Different scopes never share                            | `sharedQuery.test.tsx`: equal keys share, differing period, project, or zone do not                                                                                                                                                                       |
| Failed reads clear numbers and can be retried           | `sharedQuery.test.tsx`; the dashboard's failed-load tests                                                                                                                                                                                                 |
| Malformed layouts recover without losing supported data | `a malformed layout recovers what it can`: bad settings fall back to defaults with a notice, an unknown widget type and its config are kept, sizes are clamped, only an unusable ID is dropped, and nothing is rewritten until the user changes something |
| Restart                                                 | `dashboards` tests: layouts, names, and the default survive; the Phase 5 journey test                                                                                                                                                                     |
| Missing records                                         | Filters are never stored, so a removed project or habit cannot persist across a restart; links to removed records show the target screen's own message                                                                                                    |

### Gaps

- Timings are from one machine. Compare against these baselines on the same hardware, not across machines.
- The render timing uses the mocked backend, so the real cost adds the backend reads above. The webview's own IPC overhead is not measured.
- Fixtures are synthetic. A real workspace's mix of repeating series and archived habits may behave differently.
