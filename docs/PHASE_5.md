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
