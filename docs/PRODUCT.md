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

### Quick actions (U2-P5-15)

The **Quick actions** row on Home starts everyday work in the workflow that already owns the record. There are no parallel forms.

| Action                | What it does                                                                                          | Persists through                    |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------- |
| New issue             | A title field; Create issue saves an issue with no project or dates, then says "Created ISS-N title." | `create_issue`                      |
| New document          | Creates a document and opens it in the editor, with a link back to Home                               | `create_document`                   |
| Add event             | Opens the calendar's own event editor on today                                                        | `create_calendar_event`             |
| Schedule issue work   | Choose an open issue; opens it, where work sessions are planned                                       | The issue's own Work sessions panel |
| Record a check-in     | Opens the check-in screen                                                                             | `save_checkin` (on that screen)     |
| Open a recent project | Opens the most recently changed active project                                                        | None                                |
| Mark done (habits)    | Each habit due today has Mark done / Undo                                                             | `set_habit_completion`              |

- **Refresh.** Writes go through the shared command wrapper, so a successful change publishes its sources and the Home sections and dashboard widgets that read them refresh. A failed write publishes nothing.
- **Cancel and failure.** Cancel closes the form and returns focus to the button that opened it. A failed create keeps what was typed, shows the error, and leaves focus in the field. A successful create returns focus to its button and announces the result. The dialogs return focus to their opener.

### Resuming work (U2-P5-16)

Home shows where to pick work back up without keeping a browsing log.

- **In progress.** Open issues whose status is In progress, most recently changed first, at most 5, each with the day it last changed. Archived issues are never listed.
- **Recent documents.** Ordered by when each was last opened, or for one never opened, when it last changed (the line says "opened" or "changed"). Ties break by ID, so the order is stable. Archived documents are omitted. A document deleted since is simply gone from the list; if one is deleted between listing and clicking, the editor says it is unavailable.
- **Active projects.** Active projects only, most recently changed first, each with a link to the project and one to its issues. Completed, on-hold, and archived projects are omitted.
- **No new metadata.** The only resume state is `documents.opened_at`, which already exists. It is one timestamp per document, owned by the document's workspace, written when the document is opened or created, kept for as long as the document exists (including while archived), and removed with the document. Issues and projects use their own `updated_at`. Nothing records which screens were visited, and nothing is stored for projects or issues beyond what they already hold. A test checks that opening is workspace-scoped and that the timestamp survives archiving.
