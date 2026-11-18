# Performance and accessibility

This records the U2-027 audit: how to repeat the measurements, the results, what was fixed, and the gaps left open. Rerun the fixtures after changes to queries, list rendering, or theme tokens.

## Targets

- **Backend.** Each query a page sends finishes within one frame (16 ms) at 5,000 issues, except deliberate full-workspace reads such as export.
- **Rendering.** At 500 issues, each main page shows its content within 200 ms of navigation, with no main-thread task over 50 ms.
- **Accessibility.** No automated WCAG 2.2 AA violations on any page or open panel, in light or dark mode. Every keyboard stop shows a focus indicator. Form fields have borders of at least 3:1 (WCAG 1.4.11). No page scrolls sideways at the window's minimum width of 620 px.

## Backend queries

`src-tauri/src/perf_tests.rs` builds disposable file databases and times each query 20 times after a warm-up. The 500-issue workspace represents daily personal use. The 5,000-issue workspace shows the headroom. Each fixture has 12 projects, 8 labels, 12 milestones, a mission with an objective, and issues spread across statuses, the Inbox, three months of due dates, labels, milestones, and parent links.

```sh
cargo test --release --manifest-path src-tauri/Cargo.toml perf_tests -- --ignored --nocapture
```

Release build, Apple M5, macOS 26.5.1:

| Query                              | 500 issues | 5,000 issues |
| ---------------------------------- | ---------: | -----------: |
| Issues: first page (open, updated) |    0.57 ms |      2.13 ms |
| Issues: text search                |    0.22 ms |      2.29 ms |
| Issues: label + priority filters   |    0.39 ms |      4.62 ms |
| Board: one status column           |    0.87 ms |      2.48 ms |
| Today: due today or overdue        |    1.10 ms |      4.91 ms |
| Calendar: one month                |    1.08 ms |      4.29 ms |
| Project overview                   |    1.09 ms |      9.26 ms |
| Project goals with rollups         |    0.13 ms |      0.15 ms |
| Milestones with counts             |    0.81 ms |      8.46 ms |
| Workspace search                   |    0.46 ms |      3.64 ms |
| All issues (relationship picker)   |    3.86 ms |     42.09 ms |
| JSON export                        |    4.04 ms |     39.54 ms |

Every page query meets the target at both sizes, so no index or query was changed. The two full-workspace reads scale linearly, as expected. Export runs only when asked. The relationship picker is listed under gaps.

## Rendering

`tests/browser/performance.spec.ts` seeds the in-memory IPC mock and times in-app navigation until each page's first content is visible, taking the median of three runs. It also sums main-thread long tasks over 50 ms. The mock answers instantly, so these numbers measure the UI only. Add the backend time above for the full cost. The fixture is opt-in because wall-clock times vary by machine.

```sh
PERF=1 npx playwright test performance --reporter=line
```

Chromium (Playwright), Apple M5:

| Page                            | 500 issues | 2,000 issues |                             Long tasks |
| ------------------------------- | ---------: | -----------: | -------------------------------------: |
| Issues list                     |      78 ms |        79 ms |                                   none |
| Board (via the issue list)      |     178 ms |       180 ms |                                   none |
| Today                           |      94 ms |        98 ms |                                   none |
| Calendar                        |      76 ms |       141 ms |                                   none |
| Project overview (via Projects) |     112 ms |       114 ms |                                   none |
| Relationship picker, opening    |      50 ms |        79 ms | none, one 50 ms task in an earlier run |

The board and overview timings each include two navigations. Lists and board columns are paged, so their cost does not grow with the workspace. The calendar and picker load every matching issue, so they grow with it but stay within the target at 2,000 issues.

## Accessibility audit

`tests/browser/accessibility.spec.ts` runs in `npm run test:browser`:

- **Pages.** It runs axe-core (`@axe-core/playwright`, WCAG 2.0 to 2.2 A and AA rules) on 21 pages with seeded records in light and dark mode, with reduced motion requested.
- **Interactive states.** It scans open panels in both modes: the search dialog with an active result, the board's Move menu, the relationship form, the archived banner and deletion panel, the project dialog, and the keyboard shortcut help.
- **Focus.** It tabs through eight pages in both modes and fails on any stop without an outline of at least 2 px or a focus shadow.
- **Field borders.** It checks every visible text field, select, and text area, or the row that frames it, for a 3:1 border against what is behind it. Axe does not check this.
- **Reflow.** It fails if any page scrolls sideways at 620 px, the minimum window width in `tauri.conf.json`.

The existing browser tests cover the main workflows by keyboard: capture with N, search with F and ⌘K, list traversal and completion, board Move menus, and the deletion and import confirmations.

### Defects found and fixed

| Defect                                                                                         | Where                                                                                                            | Fix                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Accent text on the selection tint was 4.35:1, below 4.5:1                                      | Light mode: active navigation, `.action` buttons, status badges, pressed filters, on all 21 pages (116 elements) | `--accent` darkened from `#5263cf` to `#4c5ecd`, the nearest shade of the same hue that is at least 4.5:1 on every light surface        |
| Form field borders were 1.25:1 (light) and 1.5:1 (dark)                                        | Every text field, select, and text area, and the underlined title fields                                         | New `--control-line` token (`#85838c` light, `#8c8890` dark) for field borders. `--line` stays for decorative dividers                  |
| Status links' names did not include their visible text, so voice control could not target them | Project overview, Issues by status                                                                               | Removed the `aria-label`. A visually hidden "issues" completes the visible "To Do 3"                                                    |
| Search results listbox held a button, headers, and notes, which listboxes cannot own           | Workspace search                                                                                                 | "See all" is now the group's last option, reachable with the arrow keys. Group headers name their group but are hidden from the listbox |
| No focus indicator                                                                             | Description editor, and date fields once focus moves to their parts or picker button                             | `.ProseMirror:focus-visible` ring. Date fields ring on `:focus-within`                                                                  |
| The search input had `outline: none` and no replacement                                        | Workspace search                                                                                                 | The field row shows an accent underline while focused                                                                                   |
| The board widened the whole page, for example by 732 px at 620 px                              | Board pages                                                                                                      | Visually hidden column text was positioned against the page. The board is now its own containing block, so it scrolls inside its region |

Reduced motion: the app's own CSS has no animations or transitions. A global `prefers-reduced-motion` rule now also stops library animations, such as the calendar's drag revert.

## Calendar

U2-P3-19 recorded this baseline for the calendar. No optimization was made, so these numbers are a starting point, not an improvement.

### Backend

`perf_tests::measure_calendar_sizes` builds disposable file databases of 500 and 5,000 events. Each has one repeating series per ten events (daily, weekly, and monthly, with cancelled occurrences), all-day and timed events in four time zones, a reminder on one in four, links on one in five, and half as many issues, each with a deadline and a work block. Queries are the mean of 20 runs after a warm-up. The ICS rows run once.

```sh
cargo test --release --manifest-path src-tauri/Cargo.toml measure_calendar_sizes -- --ignored --nocapture
```

Release build, Apple M5, macOS 26.5.1:

| Operation                     | 500 events | 5,000 events |
| ----------------------------- | ---------: | -----------: |
| Day view                      |    0.48 ms |      5.12 ms |
| Week view                     |    0.58 ms |      6.76 ms |
| Month view (six weeks)        |    1.86 ms |     20.31 ms |
| Search: text                  |    4.46 ms |     51.38 ms |
| Search: blank (upcoming)      |    7.40 ms |     31.25 ms |
| Reminders: check for due ones |    0.97 ms |     10.40 ms |
| Event links                   |    0.08 ms |      0.14 ms |
| ICS export (all events)       |    5.04 ms |     54.90 ms |
| ICS import (all events)       |   33.26 ms |  1,112.90 ms |

At 500 events every page query is inside one frame (16 ms). At 5,000 events the Month view (20 ms) and both searches (31 and 51 ms) are over it. They stay well under a perceptible delay, and search is typed, not scrolled, so no index or query was changed. If a larger schedule matters, the first candidates are an index on event titles for search and narrowing the Month read to the visible range.

### Rendering

`tests/browser/performance.spec.ts` seeds timed events across November 2026 and times a navigation until the first event is in the page, the median of three runs, with the in-memory IPC mock (so UI cost only). The events are dense: 500 is about 18 a day, and 2,000 about 70 a day.

```sh
PERF=1 npx playwright test performance -g "calendar views" --reporter=line
```

Chromium (Playwright), Apple M5:

| View   | 500 events | Long tasks | 2,000 events | Long tasks |
| ------ | ---------: | ---------: | -----------: | ---------: |
| Day    |      69 ms |       none |        83 ms |       none |
| Week   |      91 ms |       none |       173 ms |      69 ms |
| Month  |     136 ms |       none |       298 ms |     223 ms |
| Agenda |     183 ms |      74 ms |       431 ms |     340 ms |

At 500 events every view meets the 200 ms target, though Agenda has one 74 ms task. At 2,000 events Month and Agenda miss both the time target and the 50 ms task limit. That is a month holding about 70 events a day, far denser than personal use, and a day view of that many events draws columns too narrow to read. The calendar loads at most 2,000 items per window and says so when it truncates. Rendering only the visible days of Month and Agenda is the likely fix if it is needed.

## Habits, check-ins, and the dashboard

U2-P4-21 measured these on synthetic data and checked accessibility with data loaded. Separate evidence is kept for the native database, the browser UI, and automated checks.

### Backend

`perf_tests::measure_habit_sizes` builds disposable file databases. _Small_ is 10 habits and 1 year (2,541 completions, 183 check-ins). _Large_ is 30 habits, five of them archived, and 5 years: 38,241 completions checked on about seven days in ten, and 913 check-ins. Queries are the mean of 10 to 20 runs after a warm-up; restore runs once.

```sh
cargo test --release --manifest-path src-tauri/Cargo.toml measure_habit_sizes -- --ignored --nocapture
```

Release build, Apple M5, macOS 26.5.1, after the fix below:

| Operation                     |    Small |     Large |
| ----------------------------- | -------: | --------: |
| Habits: list                  |  0.08 ms |   0.13 ms |
| Grid: one month               |  0.24 ms |   0.47 ms |
| History: one habit, all days  |  0.47 ms |   2.49 ms |
| Statistics: 30 days           |  3.49 ms |  59.55 ms |
| Statistics: 366 days          |  3.47 ms |  64.26 ms |
| Check-in trends: 366 days     |  4.17 ms |  71.68 ms |
| Dashboard analytics: 30 days  |  3.61 ms |  69.77 ms |
| Dashboard analytics: 366 days |  4.60 ms |  67.66 ms |
| Backup: export all history    |  3.49 ms |  67.67 ms |
| Restore: preview              |  3.85 ms |  75.30 ms |
| Restore: replace all history  | 14.80 ms | 219.95 ms |

The daily-use queries (list, grid, one habit's history) are far inside one frame at both sizes. **Fixed:** the dashboard analytics took 140 ms at the large size because the check-in analytics asked the habit engine for statistics just to get week and month boundaries; they now compute the boundaries alone unless the habit comparison is requested (70 ms). **Not fixed:** statistics still read every completion in the workspace, because streaks need the whole history, and take about 60 ms at 38,000 completions regardless of the period. Faster date parsing was tried and changed nothing, so the cost is reading and grouping the rows. That is over one frame but well under a perceptible delay, and it runs once when a panel opens. If it matters, the candidates are computing streaks in SQL or caching per-habit streaks keyed by the habit's revision.

### Rendering

`tests/browser/performance.spec.ts` seeds the in-memory IPC mock with the large fixture (30 habits, 38,311 completions) and times navigation to first content, the median of three runs, with the main-thread long tasks over 50 ms.

```sh
PERF=1 npx playwright test performance -g "habit tracking" --reporter=line
```

Chromium (Playwright), Apple M5:

| Step                                      | Time to content | Long tasks |
| ----------------------------------------- | --------------: | ---------: |
| Month grid, 25 active habits by 30 rows   |          320 ms |     116 ms |
| Previous month in the grid                |          135 ms |      74 ms |
| History: open the year heatmap (366 days) |           56 ms |       none |
| Trends: open the panel (reads 366 days)   |           78 ms |       none |

The mock filters all 38,000 records on every read, so the grid rows include that cost and overstate the UI. The full grid draws about 750 checkbox buttons and keeps the ARIA grid semantics, with one Tab stop. The first load misses the 200 ms target and has a task over 50 ms. No change was made without evidence that the UI, not the mock, is the cause; that is the first thing to establish with a native profile.

### Accessibility

`tests/browser/trackingAccessibility.spec.ts` runs axe-core (WCAG 2.0 to 2.2 A and AA) with data loaded in light and dark mode, with reduced motion requested, on:

- **Habits:** the grid, the trends panel with its tables open, the history month and year views, Manage habits with routines and history open, the deletion review, the Ember import preview, and Backup and restore.
- **Check-ins:** the form, an edited record, and the trends with the habit comparison on.
- **Dashboard:** every section with its details open, the Sections list, an invalid custom period, and a project filter.
- **Focus and motion:** it tabs through `/habits` (with trends and history open), `/mood`, and `/dashboards` and fails on a stop without a visible indicator, and fails if any element in the page animates or transitions under reduced motion.
- **Reflow:** it fails if these pages scroll sideways at 620 px, the minimum window width, with the year heatmap open.

Color is never the only signal: the grid, history, and charts also use symbols, borders, text, and data tables, and `habitDashboard`, `habitHistory`, and `moodTrends` specs assert them.

| Defect found                                                                    | Where                    | Fix                                                        |
| ------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| Move buttons' names ("Move Walk up") did not contain their visible text         | Manage habits            | Names now start with the visible text: "Move up, Walk"     |
| Delete button's fallback red failed contrast in dark mode                       | Habit deletion review    | The danger style uses the text color with a heavier border |
| A details panel nested inside another details panel failed the target-size rule | Dashboard Habits section | The data table is one details panel, not two               |

## Packaged app and resource audit (U2-P6-13)

Measured on 2026-11-18 at commit `8d83a26`: a release build of the packaged macOS app (`npx tauri build --bundles app`, 25.06 MiB bundle). Hardware: Apple M5, 10 cores, 16 GiB memory, macOS 26.5.1. Windows was not measured.

### Method

The app binary was launched from a script with `HOME` pointed at an empty throwaway folder, so it created its own new workspace and never opened a real one. Each run:

- **Startup**: time from launch until the main window (wider than 300 px) is on screen, polled every 5 ms. This is window creation, **not** first paint of the page content, which the app does not expose and was not measured.
- **Memory**: resident memory of the main process 10 seconds after launch. The operating system's WebKit helper processes (page rendering) are separate and were **not** included, so this understates total use.
- **Idle CPU**: the main process's CPU over three 3-second samples (`top`), after the 10 seconds, with the app untouched.
- **Cold**: first launch with no data folder, so the app creates the database and applies all 29 migrations. The operating system's file cache was not purged, so only the first run after the build had a truly cold cache. **Warm**: relaunch with the data folder in place.

| Run    | Window on screen | Main process memory | Idle CPU |
| ------ | ---------------: | ------------------: | -------: |
| Cold 1 |         1,074 ms |              108 MB |     0.0% |
| Cold 2 |           221 ms |              111 MB |     0.1% |
| Cold 3 |           209 ms |               96 MB |     0.0% |
| Warm 1 |           235 ms |              110 MB |     0.0% |
| Warm 2 |           213 ms |              108 MB |     0.1% |
| Warm 3 |           215 ms |              105 MB |     0.1% |
| Warm 4 |           194 ms |              109 MB |     0.1% |
| Warm 5 |           193 ms |              104 MB |     0.1% |

The first run (1.07 s) was the first launch of a new build and includes the system loading it. Later runs, new or existing data folder, put a window up in about 0.2 s. Idle CPU is effectively zero. In a separate run the app's new database held all 29 migrations and was in write-ahead logging mode, so the Rust side was working, but no run looked at the rendered page.

### Editing, lists, calendar, habits, dashboard, graph, size

| Area                     | Result                                                                                                                                                                                                                                                                                                              | Source                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Document editing         | Typing one character into a 1,000, 5,000, and 20,000-word document: median 0.1 ms, 95th percentile 0.2 to 0.3 ms, worst 3 to 12 ms; opening the largest takes 17 ms and serializing it under 1 ms. This runs the app's own editor schema in Chromium **without** the React page, toolbar, or page layout around it. | `tests/browser/documentPerformance.spec.ts` (`PERF=1`) |
| Large issue list         | First page 0.57 ms at 500 and 2.13 ms at 5,000 issues; the page shows content in about 80 ms at 500 and 2,000 issues                                                                                                                                                                                                | Sections above                                         |
| Calendar rendering       | Month view 1.86 ms at 500 events and 20.31 ms at 5,000; page 76 ms at 500 and 141 ms at 2,000 issues                                                                                                                                                                                                                | Calendar section                                       |
| Habit history, dashboard | Measured in the section below with their own fixtures                                                                                                                                                                                                                                                               | Habits section                                         |
| Knowledge graph          | The 500-note global graph renders and filters in a test that takes about 2 s in total, including seeding and navigation. Draw time alone was not measured.                                                                                                                                                          | `documents.spec.ts`                                    |
| Database size and growth | After a full checkpoint: a new workspace 536 KiB (all tables and indexes empty), 500 issues 1,116 KiB, 5,000 issues 6,724 KiB. That is about 1.2 KiB per issue with its fixture links. A new packaged workspace also has a `-wal` file of about 1.3 MB until the app checkpoints on a clean quit.                   | `perf_tests::measure_database_size` (`--ignored`)      |

### Findings

| ID     | Severity | Finding                                                                                                                                                           | Status                                                                             |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PERF-1 | Info     | No resource problem found at this scale: window in about 0.2 s, idle CPU about 0%, main-process memory about 100 MB.                                              | None needed.                                                                       |
| PERF-2 | Open     | Not measured: first paint of page content, total memory including WebKit helpers, packaged-app interaction with a large populated workspace, and any Windows run. | Measure on the packaged builds with a populated workspace (U2-P6-17 and U2-P6-18). |

## Beta accessibility and consistency audit (U2-P6-14)

Run on 2026-11-18 on `main` after #240 plus this change (after the brand and UI overhaul), Chromium on macOS arm64. All suites below were rerun in full: 25 existing tests passed unchanged, then the new document editor spec was added. Command: `npx playwright test accessibility dashboardAccessibility trackingAccessibility documentAccessibility`.

| Scope item                       | How it was checked                                                                                                                                                                                                      | Result                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Keyboard navigation              | Every page's focusable controls reached by Tab (`accessibility.spec.ts`); dashboard operated by keyboard alone; habit grid, check-ins, calendar keyboard tests; the document editor reached backward from the text area | Pass                                                                         |
| Focus indicators                 | Every stop on 8 pages, dashboard view and arrange mode, tracking pages, and the editor needs an outline of at least 2 px or a focus shadow                                                                              | Pass                                                                         |
| Screen-reader semantics          | axe rules for roles, names, landmarks, and listbox ownership on all 27 routes plus open panels; charts have names, legends, and a **Show values** table                                                                 | Pass by automated rules. Not tested with a real screen reader (see below)    |
| Color contrast                   | axe `color-contrast` in both themes on every route and panel; chart series at least 3:1; form borders at least 3:1                                                                                                      | Pass                                                                         |
| Form labels                      | axe label rules on every form, dialog, and filter; **new**: label-in-name on the editor toolbar                                                                                                                         | Pass after 1 fix                                                             |
| Accessible dialogs               | Search, project, issue, calendar, dashboard (New, Rename, Delete, Reset), and tracking dialogs scanned open; Escape and focus return covered in feature specs                                                           | Pass                                                                         |
| Chart descriptions               | Dashboard charts: accessible name with title, range, series, highest value; text table; distinct empty and unavailable states                                                                                           | Pass                                                                         |
| Reduced motion                   | All accessibility suites run with `prefers-reduced-motion: reduce`; the app stylesheet clamps animations                                                                                                                | Pass                                                                         |
| Light and dark themes            | Every scan above runs in both                                                                                                                                                                                           | Pass                                                                         |
| Responsive layout, minimum width | No sideways scroll at 620 px (the window's minimum width) on every route, the dashboard with every widget at 620 and 375 px, tracking pages, and the editor                                                             | Pass                                                                         |
| Consistent interaction           | Shared layout, dialog, button, and field styles; checked by the same scans                                                                                                                                              | Reviewed only by the automated scans; no separate consistency measure exists |

### Defects found and fixed

The existing suites reached only the document library, not an open document. A new scan of the open editor with every toolbar panel expanded (`tests/browser/documentAccessibility.spec.ts`) found two problems, both fixed without changing the visual design:

| Defect                                                                                                                                                                          | Fix                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| The Superscript and Subscript buttons showed "x²" and "x₂" but were named only "Superscript" and "Subscript", so voice control saying what is on screen would miss (WCAG 2.5.3) | The accessible name now contains the glyph ("x² Superscript"). |
| The **Open local graph** link in the document links panel was shorter than 24 px (WCAG 2.5.8)                                                                                   | A 24 px minimum height for that link.                          |

### Not covered and remaining limitations

- No session with VoiceOver, NVDA, or JAWS was run. Automated rules do not prove a good screen-reader experience.
- Not tested: Windows high-contrast or forced-colors mode, browser zoom of 200% or more, user text-spacing overrides, and the minimum window height (460 px). Reflow was checked by width only.
- Windows WebView2 and macOS WKWebView were not used; the scans ran in Chromium.
- Rich-text content typed by a user (for example heading order inside a document) is not checked by these rules.

## Gaps

- **Relationship picker at large sizes.** Adding a relationship loads every issue and renders one `<select>` option per issue: 42 ms backend and 80 ms rendering at 2,000 to 5,000 issues, and slow to scan by keyboard. It meets the target at the representative size. A searchable picker backed by `query_issues` would remove the full load. This is tracked in #52 rather than built speculatively here.
- **Native WebKit.** The rendering and accessibility checks run in Chromium. The macOS app uses WebKit, so check focus rings, date fields, and contrast in the native smoke test.
- **Screen readers.** Automated checks do not replace a pass with VoiceOver or a Windows screen reader. Neither has been run for the habit, check-in, or dashboard screens.
- **Habit statistics at 38,000 completions.** About 60 ms per read, and the grid's first load, are recorded above and not optimized.
