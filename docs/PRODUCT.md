# Product

Unhollowed 2 brings documents, planning, and personal routines into one private desktop workspace. The product should stay free to use and work offline without accounts. Shared workspace and record IDs will connect features as they are built.

Phase 0 provides navigation, appearance settings, and the SQLite foundation. The next phase establishes workspace ownership and data compatibility. Documents and links, projects and tasks, calendar and routines, and dashboards follow in the GitHub milestones.

## Home: today's summary (U2-P5-14)

Home opens on what needs attention today and keeps the directory of areas under **All areas**.

| Section             | Shows                                                                      | Source                                    | Links to                                  |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| Overdue             | Open issues due before today, oldest due first, at most 5                  | `query_issues` (`dueBefore` yesterday)    | The issue, and the full filtered list     |
| Due today           | Open issues due today, by priority, at most 5                              | `query_issues` (`dueAfter` = `dueBefore`) | The issue, and the full filtered list     |
| Schedule            | Today's events and planned work sessions (the Today screen's own schedule) | Calendar `list_items`                     | The calendar and each event or issue      |
| Habits today        | Habits that can be completed today, done or not                            | `get_habit_month`                         | Each habit on today's date, and `/habits` |
| Upcoming milestones | Open milestones overdue or due within 14 days, nearest first, at most 5    | Progress analytics deadlines              | Milestones                                |
| Recent documents    | Last opened or changed, never archived, at most 5                          | Document library                          | The document                              |
| Active projects     | Active projects, most recently changed first, at most 5                    | `list_projects`                           | The project                               |

- **Bounded.** Each list shows a handful of items and a "N more" link to the full list. Order is fixed (ties break by ID) so Home never reshuffles between visits.
- **Independent.** Each section has its own loading, empty, and error state with Retry. One failing source leaves the others as they are.
- **Date changes.** Home reads today from the local clock, which updates at local midnight and when the window regains focus. Every section re-reads for the new day.
- **No history.** Home shows today and what is open now; trends stay on Dashboards.
