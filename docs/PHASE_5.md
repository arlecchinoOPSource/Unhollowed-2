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
