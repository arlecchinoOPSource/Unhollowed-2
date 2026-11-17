# Data model

This page defines how records are owned and identified. Follow it for every table added after migration 2.

## Workspace ownership

Every user record belongs to exactly one workspace. Documents, projects, tasks, events, habits, and mood entries each carry a `workspace_id` that references `workspaces (id)`. Workspaces are the unit of scoping, so a query for one workspace never returns another's rows.

`app_state` has a single row (`singleton = 1`) that holds `active_workspace_id`, the workspace the app opens. Rust reads it with `active_workspace` in `src-tauri/src/database.rs`. Feature commands should call that function and filter by the returned ID instead of hard-coding a workspace.

```text
app_state (singleton = 1)
  active_workspace_id ──► workspaces.id
workspaces
  id, name
      ▲
      │ workspace_id (required)
  documents, projects, tasks, events, habits, mood entries, …
```

## Stable IDs

- Every table has `id TEXT NOT NULL PRIMARY KEY` holding a lowercase UUID string. Generate IDs in Rust, never from row order or `rowid`.
- IDs never change and are never reused. Do not store them in a form that depends on names or positions.
- The Phase 0 Personal workspace keeps `00000000-0000-4000-8000-000000000001`. This fixed value exists only for that seeded row. New records use generated UUIDs.

## Foreign keys

- A required owner is `NOT NULL REFERENCES … ON DELETE RESTRICT`. Deleting a parent must be an explicit decision, so the database refuses it by default. Use `ON DELETE CASCADE` only for rows that cannot exist without the parent and are documented as such in the migration.
- An optional relationship, such as a task's project, is a nullable column with an explicit foreign key and `ON DELETE SET NULL`. Include `workspace_id` on both rows and keep them consistent in the write command.
- Document links and graph edges reference document IDs and carry their own `workspace_id`.
- SQLite connections from sqlx enforce foreign keys. Tests that depend on this should assert the rejection.

## Documents

`documents` follows the conventions above: a UUID `id`, a required `workspace_id` with `ON DELETE RESTRICT`, a non-empty `title`, and `content`, which holds Tiptap (ProseMirror) JSON as text. SQLite checks that `content` is valid JSON, and Rust additionally requires a root node of type `doc` and limits titles to 200 characters and content to 5 MB. The stored text is returned exactly as saved so formatting round-trips. `created_at` and `updated_at` are UTC ISO 8601 strings set by SQLite.

Rust resolves the active workspace for document commands. Document reads and mutations match IDs together with their workspace. The WebView does not choose the workspace for a command.

- **Revisions.** Migration 15 adds workspace-scoped checkpoints. Routine edits checkpoint the previous version at most once every five minutes. Restoring a revision also checkpoints the displaced document in the same transaction. SQLite retains the latest 20 revisions per document.
- **Images.** Migration 16 stores PNG, JPEG, GIF, and WebP assets as SQLite BLOBs, with an 8 MiB limit per image. Imports and duplicates allocate new image IDs in the same transaction as the document. Older images remain available for revision history.
- **Library.** Migration 17 adds folders, archive timestamps, favorites, and last-opened metadata. Folder parents and document folder assignments belong to the same workspace. Archiving preserves project links and direct navigation.
- **References.** Migration 18 indexes stable document IDs from internal-link marks. Edges are unique, workspace-scoped, and updated with the document content. Restores update the index. Titles are resolved from the linked records.
- **Search.** Migration 19 indexes active document titles, body text, and image descriptions with FTS5. Existing documents are indexed on migration, and triggers track edits, archive, restore, and deletion.

See [Document editor](DOCUMENT_EDITOR.md) for recovery behavior and file compatibility.

## Projects

`projects` stores a workspace-owned UUID, name, optional description, status, optional local calendar dates in `YYYY-MM-DD` form, and UTC creation and update timestamps. New projects start as planned. Archiving is a status change, so the project keeps its ID and stays available through the Archived filter. Rust validates dates and requires the target date to be on or after the start date when both are present.

Project commands resolve the active workspace in Rust. Reads and changes match the project ID and workspace ID together. Future feature records can reference the stable project ID under the ownership rules above.

## Issues

`issues` stores a workspace-owned UUID, a readable `number`, an optional `project_id`, a title of 1 to 200 characters, a Tiptap JSON `description`, status, priority, optional `start_date` and `due_date` in `YYYY-MM-DD` form, `completed_at`, and UTC creation and update timestamps. The interface shows the number as `ISS-<number>`.

- **Numbers.** `issue_counters` holds the last number issued per workspace. `create` in `src-tauri/src/issues.rs` increments it and inserts the issue in one transaction, so concurrent creates get distinct numbers and a failed create does not use one. Numbers are unique per workspace, only increase, and are never reused after an issue moves to another project or is deleted.
- **Statuses.** `todo`, `in_progress`, `blocked`, `done`, and `canceled`. The `closed` column is generated from status and is true for done and canceled issues. `completed_at` may be set only while the status is done.
- **Priorities.** `none`, `low`, `medium`, `high`, and `urgent`.
- **Projects.** An issue with no project is in the workspace Inbox. The project must belong to the issue's workspace. Rust checks this in each write, and triggers reject cross-workspace links. Deleting a project moves its issues to the Inbox (`ON DELETE SET NULL`) without changing their IDs or numbers.
- **Descriptions** follow the document content rules: valid JSON with a `doc` root, up to 5 MB.

Indexes lead with `workspace_id` for workspace and project lists.

Issues are read and changed only through the commands in `src-tauri/src/issues.rs`: `list_issues` (optionally for one project), `get_issue`, `create_issue`, `update_issue`, `change_issue_status`, `complete_issue`, `cancel_issue`, `reopen_issue`, and `set_issue_project`. Each one resolves the active workspace in Rust, and errors are returned as `{ code }` objects. Lifecycle rules:

- Entering done sets `completed_at` once. Any other status clears it.
- Reopening returns a done or canceled issue to To Do and leaves an open issue's status unchanged.
- Repeating a status, reopen, or project change is a no-op that keeps `updated_at` and `completed_at`, so retries are safe.
- `update_issue` changes title, description, priority, and dates without affecting status or project. Archiving and deletion are not implemented yet.

### Issue search, filtering, and sorting

`query_issues` takes one `IssueQuery`: an `IssueFilter` plus sort and paging. `IssueFilter` (`src-tauri/src/issues/query.rs`, mirrored in `src/database/issues.ts`) is the shared filter definition for lists, board, and saved views. Empty lists and missing values mean no restriction. Filters combine with AND, and values within one list combine with OR.

- **Search.** `search_text` holds the title and the text nodes of the Tiptap description, with a line break after each block, lowercased with Rust's full Unicode rules. Rust writes it on every create and update. Queries are trimmed and lowercased the same way and matched as literal substrings with `instr`, so `%`, `_`, and other characters have no special meaning. Rows saved before migration 6 have a NULL `search_text`. The first query in a workspace fills them in without changing `updated_at`. A scan of one workspace's rows is fast at the expected hundreds of issues, so there is no full-text index. FTS5 would also match tokens, not literal substrings.
- **State, status, priority, project.** `state` is `open`, `closed`, or `all` and follows the generated `closed` column. `projectIds` matches any listed project, and `inbox` adds issues with no project. Unknown project IDs match nothing.
- **Due dates.** `dueAfter` and `dueBefore` are inclusive local dates. `undated` is `include` (the default), `exclude`, or `only`. With a range, `include` also returns undated issues. `only` cannot be combined with a range.
- **Sorting.** `updated` (default, newest first), `created`, `priority` (urgent highest), `title` (case-insensitive), or `due`, each `asc` or `desc`. Every order ends with the issue number in the same direction, so ties are stable and pages never repeat or skip rows. Undated issues sort after dated ones in both directions.
- **Paging and counts.** `limit` is 1 to 200 (default 100) with an `offset`. The response includes `total` for the whole query and `open` and `closed` counts for the query without its state.

Invalid values return `invalid_filter`. Every query is scoped to the active workspace and binds all values as parameters.

## Labels

`labels` stores workspace-owned labels: a 1 to 50 character name, an optional description of up to 500 characters, a color from a fixed palette (`gray`, `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`), `archived_at`, and timestamps. `name_key` is the name lowercased by Rust with full Unicode rules, and `UNIQUE (workspace_id, name_key)` makes names differing only in case duplicates. Archived labels keep their names reserved.

`issue_labels` links issues and labels, with its own `workspace_id` and a primary key of `(issue_id, label_id)`, so each link is unique. A link cannot exist without both its issue and its label, so it uses `ON DELETE CASCADE` on both. Triggers require both ends to belong to the link's workspace, reject new links to archived labels, and forbid editing links in place.

- `set_issue_labels` replaces an issue's labels in one transaction. Archived labels the issue already has can stay or be removed but cannot be added. A failed request changes nothing, and repeating the same set keeps `updated_at`.
- Every issue read returns `labelIds`, including archived labels, so historical assignments stay visible. `list_labels` returns active labels first, then archived, each by name, with an `issueCount`.
- `IssueFilter.labelIds` matches issues with `any` (the default) or `all` of the labels in `labelMatch`. Archived labels still match.
- Badges always show the label name, and archived labels say so in text. Each palette color has light and dark theme values with at least 3:1 contrast on that theme's surfaces, which `tests/unit/labels.test.tsx` checks against the theme tokens.

## Milestones

`milestones` stores workspace-owned checkpoints: a 1 to 200 character title, an optional plain-text description of up to 5,000 characters, an optional local `due_date`, an `open` or `closed` state with `closed_at`, and timestamps. `project_id` is NULL for a workspace milestone, or a project in the same workspace for a project milestone. The scope is chosen at creation and cannot change. `project_id` uses `ON DELETE RESTRICT`, so a project with milestones cannot be deleted until safe deletion (U2-025) defines what happens to them.

`issues.milestone_id` holds at most one milestone per issue and is cleared if the milestone is deleted (`ON DELETE SET NULL`).

- **Compatible links.** An issue can use any workspace milestone in its workspace, or a milestone for its own project. `set_issue_milestone` checks this, and triggers on `issues` reject incompatible links, including a project change that would leave one behind. Repeating the current milestone keeps `updated_at`.
- **Project moves.** `set_issue_project` clears a milestone that belongs to another project in the same update. Workspace milestones stay, and moving back does not restore a cleared milestone.
- **Closed milestones** keep their issues and counts but cannot gain new issues until reopened. Closing or reopening is idempotent.
- **Counts and progress.** `list_milestones` derives `openCount` (open issues), `completedCount` (done), and `canceledCount` (canceled) from the milestone's issues when it is read, so counts follow completion, reopening, reassignment, and project moves without stored totals. Progress is completed out of open plus completed. Canceled issues are shown separately and do not count. A milestone with no open or completed issues shows "No issues yet" instead of a percentage.
- `IssueFilter.milestoneIds` and `noMilestone` filter issues by milestone, in the same way as `projectIds` and `inbox`.

## Missions and objectives

Missions are broad project goals. Objectives describe measurable outcomes and may reference one mission in the same project. Milestones remain independent checkpoints. Objectives may link to multiple issues in their project, and issues may contribute to multiple objectives. Moving an issue to another project or to the Inbox clears its objective links. Progress follows the rollup rules in **Progress rollups** below.

## Issue relationships

Parent links run from child to parent, with at most one parent per issue. Blocking links run from blocker to blocked issue. Related links are symmetric and stored once in stable UUID order. SQLite foreign keys enforce workspace membership. Writes validate cycles within each directed graph while holding SQLite's writer lock. Closing an issue preserves its links and status remains visible on linked records. Only Done children count as complete. Closing a parent has no effect on its children.

## Issue board

The board (`/issues/board` and `/projects/:id/board`) has no records of its own. It shows the same issues as the list, with one column per status, and reads the same URL filters through `IssueFilterBar` and `toQuery`. Columns are statuses, so it ignores the Status filter and the open/closed state.

- Each column is a separate `query_issues` request with `statuses: [column]` and the list's sort, loading 50 cards at a time with a total and **Show more**. Large boards render at most 50 cards per column until more are requested.
- Cards move by drag and drop or with each card's **Move** menu. Both call `change_issue_status`, so lifecycle rules such as `completed_at` are unchanged. There is no manual ordering. A moved card goes to the top of its new column until the next load.
- Moves are optimistic. The board records the newest move for each issue, and only that move's reply may change the card. A failed newest move returns the card to its last saved status, with an explanation, and a late reply to an older move cannot undo a newer one.

## Today and Upcoming

`/today` and `/today/upcoming` are views over `query_issues`, with no records of their own. Both use local calendar dates (`YYYY-MM-DD` in the device's current time zone) and compare date strings, never UTC instants.

- **Today** lists open issues with a due date on or before today: **Overdue** (before today) and **Today**.
- **Upcoming** lists open issues due tomorrow or later, earliest first, grouped by date (Tomorrow, weekday names for the coming week, then dates). Both views can group by project instead, with the Inbox last.
- **Closed issues** are not listed. An issue completed in a view stays in place, marked completed and reopenable, until the view reloads.
- **Undated issues** are not listed. Both views show how many open issues have no due date and link to the list filtered to them. Start dates do not affect either view.
- **Day changes.** A timer fires at the next local midnight, built from local date fields so 23- and 25-hour daylight-saving days work. The date is also checked when the window regains focus or becomes visible, which covers sleep, missed timers, and time zone changes.
- **Schedule.** Above the tasks, Today shows the day's calendar items, read with `list_calendar_items` and stored nowhere else: all-day events, timed events and work blocks in time order, the projects an event links to, **Free in working hours**, and **Coming up** (open deadlines from tomorrow through the next 3 days). Today's own deadlines and overdue issues stay in the task list below, which is the priority list. The panel can create an event and open one in the shared editor, links work blocks and deadlines to their issues, and links to the Day view. Completing an issue keeps its work blocks, which stay listed marked "(issue completed)".
- **Free time** is the working-hours window (from the calendar preferences, starting no earlier than now) minus the merged timed events and work blocks, and gaps shorter than the grid increment are dropped. The interval helpers are in `src/features/calendar/intervals.ts` and are shared with conflict checks. Today is shown as not a working day when the preferences say so.
- **Refresh.** The schedule reloads at local midnight, when the window regains focus, and after an event change.
- **Rescheduling** uses `set_issue_due_date`, which changes only `due_date`, so the issue keeps its ID, number, description, status, and links. The new date must be on or after any start date. The view updates immediately, moves the issue between Today and Upcoming when its date crosses today, and restores it if the change is rejected. Typed dates commit on Enter or when leaving the field, never while typing.

## Issue calendar

Events, deadline projections, and work blocks follow the [calendar and scheduling contract](CALENDAR.md). `/calendar` shows issues on their due dates, read straight from issues through `query_issues`, with no calendar records. Due dates are local calendar dates, so an issue appears on the same day in any time zone and across daylight saving.

- The month grid shows six weeks starting on the Monday on or before the 1st (`src/features/calendar/monthGrid.ts`). Undated issues are not shown. Closed issues are hidden unless **Show closed issues** is on, and the **Project** filter narrows to one project or the Inbox. `month`, `project`, and `closed` live in the URL.
- One grid loads at most 1,000 issues in pages of 200, with a note when more exist.
- Day buttons use a roving tab stop: arrow keys move by day and week, Home and End to the week's ends, and Page Up and Page Down by month (keeping the day of the month and clamping to shorter months). The chosen day lists every issue due then, with links to their pages, a due date field that commits on Enter or blur, and a form that creates an issue due that day (in the filtered project, if one is selected).
- Dragging an issue chip to another day, or editing its date, reschedules through `set_issue_due_date`, so the issue keeps its identity. Changes show immediately. Only the newest change to an issue applies its reply, and a rejected change returns the issue to its previous day with an explanation.
- The calendar does not use the bundled FullCalendar packages. FullCalendar injects its styles at run time, which the production CSP (`style-src 'self'`) blocks, although the development CSP allows it.

## Recurring issues

A recurring issue is a series of ordinary issues, one per occurrence. Only one occurrence of a series is normally open at a time. Completing or canceling it creates the next one.

- **Rule.** `issue_recurrences` stores the frequency (`daily`, `weekly`, or `monthly`), an interval of 1 to 99 (every N days, weeks, or months), the **anchor date**, and `stopped_at`. A rule can be set only on an issue with a due date, and that due date becomes the anchor of occurrence 0.
- **Occurrence identity.** Each occurrence issue stores `recurrence_id` and `occurrence_index`, unique per series, so occurrence N exists at most once. Its scheduled date is always computed from the anchor, never from the previous occurrence:
  - daily: anchor + N × interval days
  - weekly: anchor + 7 × N × interval days (the anchor's weekday)
  - monthly: anchor month + N × interval months, on the anchor's day of the month
- **Month-end.** If the anchor's day does not exist in a month, the occurrence falls on that month's last day. Because each date is computed from the anchor, a series anchored on 31 January lands on 28 or 29 February, then back on 31 March, and never drifts to the 28th.
- **Completion and missed dates.** Entering Done or Canceled creates the next occurrence in the same transaction as the status change. The next occurrence is the first scheduled date after the current one that is on or after the user's local today. Dates missed while an occurrence was late are skipped and create no issues, so a long absence leaves one current occurrence, not a backlog. The webview sends its local date with the completion. Without it, the next index is used.
- **Idempotency.** No occurrence is created if the series already has a later occurrence or the rule is stopped. Repeating a completion, or completing again after a reopen, therefore creates nothing new.
- **Reopen and cancel.** Reopening an occurrence does not remove a next occurrence that was already created. Canceling an occurrence skips it and creates the next one, like completion. **Stop repeating** ends the series instead.
- **Next occurrence contents.** The next occurrence copies the title, description, priority, project, and active (not archived) labels. It keeps the milestone only if the milestone is still open, and shifts any start date by the same number of days as the due date. It starts as To Do with its own ID and number.
- **Editing and stopping.** Changing the rule starts a new series anchored on the issue's current due date and stops the old one, so past occurrences keep their original schedule. Stopping sets `stopped_at`, and existing occurrences remain. Rescheduling one occurrence does not move the series: later occurrences follow the anchor's schedule.

## Saved views

`saved_views` stores a workspace-owned name (1 to 80 characters, unique per workspace ignoring case through a Rust-computed `name_key`) and a versioned JSON `config`: `{ "version": 1, "view": "list" | "board", "filters": { ... } }`. The filters are the list's URL filters (`ViewFilters` in `src-tauri/src/saved_views.rs`): state, text, status, priority, project or `inbox`, due preset, labels and label match, milestone or `none`, sort, and direction.

- **Versioning.** `config_version` records the format. Rust accepts only version 1 and rejects unknown fields (`deny_unknown_fields`) or values outside the shared filter model (`invalid_config`). A later format can migrate rows by version. A stored view that cannot be read is left out of `list_saved_views` instead of hiding the others.
- **Relative rules stay relative.** Due filters are stored as presets such as `overdue` or `week` and resolve against the local date each time the view opens. Resolved dates are never stored.
- **Navigation.** Views appear under **Saved views** in the sidebar and open the list or board with their filters in the URL plus `view=<id>`. Changing filters keeps the ID, so **Update view** saves the changes back. **Revert changes**, **Rename**, **Delete** (which removes only the view), and **Save as new view** are also available.
- **Unavailable references.** Projects, labels, and milestones a view refers to may later be deleted or belong to another workspace. When names have loaded and a referenced record no longer exists, the list or board says so and offers **Remove unavailable filters**. Archived labels and projects still exist and still match.
- **Integrations.** Only list and board filters can be saved, because they are the shared query model. Calendar and Today/Upcoming settings are not saved as views.

## Document links

`issue_documents` and `project_documents` link issues and projects to existing documents by stable ID, each with its own `workspace_id` and a primary key on the pair, so a link exists at most once. Triggers require both ends to be in the link's workspace and forbid editing links in place.

- **Content is never touched.** Linking and unlinking only add or remove link rows. They never read or write document content, so Tiptap JSON is preserved exactly. Linking an already linked document, or unlinking one that is not linked, changes nothing.
- **Missing records.** A link cannot exist without both ends, so it is removed with its issue, project, or document (`ON DELETE CASCADE`). Unlinking removes only the link, never the document. Linking a document or owner outside the active workspace returns `document_not_found` or `not_found`. Opening `/documents?doc=<id>` for a document that no longer exists shows that it could not be opened.
- **Direct and inherited.** A project page lists documents linked to the project, and separately **From this project's issues**: documents linked to its issues but not to the project, each with the issues that link it. Inherited entries follow the issue, so moving an issue out of the project removes them.
- **Navigation.** The Documents page opens the document named by `?doc=<id>`. Links from issues and projects include a **Back to** link for their origin, and each document lists the issues and projects that link to it under **Linked from**.

## Project overview

The project page opens with an overview computed by `get_project_overview` (`src-tauri/src/overview.rs`) from the project's existing issues and milestones each time it loads. Nothing is stored. Every query is scoped to the active workspace and the project.

- **Totals.** Open is To Do + In Progress + Blocked, and closed is Done + Canceled, following the generated `closed` column. Status counts cover all five statuses.
- **Completion** is done ÷ (all issues − canceled). Canceled work is neither done nor outstanding. When no non-canceled issues exist the overview shows **No issues yet**, never 0% or 100%.
- **Overdue and upcoming** use the Today and Upcoming rules with the user's local date: open issues only, overdue when due before today, upcoming from today through the next 6 days, which matches the list's **Due in the next 7 days** filter. Each list shows five issues with a total and **View all** link. Undated open issues are counted and linked separately.
- **Milestones** are the project's own milestones with the milestone progress rules (completed ÷ open + completed, canceled not counted, "No issues yet" when empty).
- **Recent activity** lists the ten newest observable events, each labeled by the timestamp it comes from: **Created** (`created_at`), **Completed** (`completed_at`), and **Last updated** (`updated_at`, when later than creation and not the completion itself). There is no change log, so "Last updated" means the issue's latest change of any kind.
- **Links.** Each number opens the matching project issue list (open, closed, overdue, due this week, each status, and undated), and milestones open their issue list.
- An empty project shows zero counts, **No issues yet**, and empty-state text for each section.

## Progress rollups

Objectives, missions, and milestones summarize progress with the same rule as the project overview, computed from live issues each time they are read, with no stored totals:

- **Denominator.** Progress is done ÷ (issues in the group − canceled). Canceled issues are neither done nor outstanding and are reported separately. **Blocked** issues are open: they count in the total, not as done, and are reported separately. A group whose total is 0 shows "No issues count toward progress yet" and no bar, never 0% or 100%.
- **Objective issues.** An objective's issues are its directly linked issues **plus their sub-issues at any depth** (through `parent` relationships) that are in the same project. The parent counts as an issue in its own right, alongside its children.
- **Mission issues.** A mission rolls up every issue of every objective that references it.
- **Deduplication.** Group membership is collected as distinct (group, issue) pairs (SQL `UNION`), then counted. An issue linked to several objectives of one mission, or linked directly and also reached as a sub-issue, counts once per group. `UNION` also ends the recursion.
- **What updates a rollup.** Completing, reopening, canceling, or blocking an issue. Linking or unlinking it. Adding or removing a parent relationship. Moving an issue to another project, which clears its objective links and stops it counting as a sub-issue.
- **Milestones** keep their rules (completed ÷ open + completed) and now also report `blockedCount`, a subset of their open issues.

## Workspace search

`search_workspace` (`src-tauri/src/search.rs`) finds projects, issues, and milestones in the active workspace for the header's **Search** dialog (also ⌘K or Ctrl+K).

- **Matching** is a literal, Unicode case-insensitive substring, as in issue search. Issues match their stored `search_text` (title and description), and `ISS-12`, `#12`, or `12` also finds issue 12. Projects (name, then description) and milestones (title, then description) are read through their workspace index and matched in Rust, because SQLite's `lower()` only folds ASCII.
- **Ranking.** Projects: name prefix, then name, then description, with active before archived. Issues: exact number, then open before closed, then most recently updated. Milestones: open before closed, then match rank.
- **Bounds.** Each group returns at most 8 results with its total. Empty or overly long text returns nothing.
- **Indexes, from measurement.** All three queries use workspace-leading indexes (`projects_by_workspace`, `issues_by_workspace_number`, `milestones_by_workspace`), as a planner test asserts. A release build searching 5,000 issues, 300 projects, and 300 milestones in each of two workspaces took about 2.3 to 3.9 ms per search (`cargo test --release search::tests::measure -- --ignored --nocapture`), so no new index was added.
- **Stale results.** The dialog waits 150 ms after typing and numbers each request. Replies to anything but the latest request are ignored.

## Archiving and deletion

Archiving is the recoverable way to remove clutter. Permanent deletion is a separate, narrow step with its own policy.

**Issue archive (recoverable).**

- `issues.archived_at` (UTC ISO 8601) marks an archived issue. Archiving is separate from the lifecycle: an issue keeps its status, `completed_at`, and `closed` value, and can be archived while open or closed. Archiving and restoring are idempotent and change no other column or row.
- Restoring clears `archived_at`. The issue keeps its ID, number, project, milestone, labels, relationships, objective and document links, and recurrence series, because archiving never touched them.
- **Defaults.** Archived issues are hidden from lists, boards, Today and Upcoming, the calendar, workspace search, the project overview, milestone counts, and goal rollups. `IssueFilter.archived` is `exclude` (the default), `include`, or `only`, and lists offer **Hide archived**, **Include archived**, and **Only archived**. Opening an archived issue by link still works and shows that it is archived. Relationship and document links to it stay visible, marked archived. Version 1 saved views always hide archived issues.
- Archiving a recurring occurrence does not stop its series.

**Project archive.** Archiving a project (the existing `archived` status) does not archive, move, or unlink its issues. They keep `project_id`, stay in issue lists, and can still be filtered by that project. The project page says how many issues it still holds. Projects cannot be deleted permanently.

**Permanent issue deletion (policy).**

- Only **archived** issues can be deleted, so every deletion is preceded by a recoverable state.
- Deletion is refused while the issue has **sub-issues**, which would leave its children without their parent, or while it is the **latest occurrence of an active repeat series**, because deleting it would silently end the series. The impact check names these blockers and how to resolve them.
- Before deleting, `issue_deletion_impact` reports what will be removed with the issue: label, document, objective, and relationship links (all `ON DELETE CASCADE`, since links cannot exist without both ends). Documents, labels, projects, milestones, and other issues are never deleted.
- The user must type the issue's key (for example `ISS-12`), and `delete_issue` requires that key, so a stray call cannot delete the wrong issue. Deletion runs in one transaction that re-checks the policy.
- The issue's number is never reused, because `issue_counters` only increases.

## Data portability

**JSON export (backup).** `export_project_data` writes one versioned JSON file, `{ "format": "unhollowed-2/projects", "version": 1, "exportedAt": … }`, to a location the user picks in the native Save dialog. Rust opens the dialog and writes the file, so the webview keeps no plugin permissions. The file holds the active workspace's:

- projects, labels (including archived), milestones, missions, and objectives
- issues, including archived ones, with title, Tiptap description, status, priority, dates, project, milestone, and readable number
- issue–label links, objective–issue links, and issue relationships (parent, blocks, related)

Not included in version 1: documents and document links, saved views, repeat series, and workspace settings. Records keep their UUIDs, and every reference in the file points to a record in the same file.

**Import.** The user chooses a JSON file, and the app shows a preview report before anything is written.

- **Validation before commit.** Rust rejects a file with the wrong `format`, an unsupported `version`, unknown fields, or invalid values (the same title, date, status, priority, color, and Tiptap rules as editing). It also rejects duplicate IDs in the file and **any reference that does not resolve inside the file**: an issue's project or milestone, a milestone's or objective's project, an objective's mission, a link or relationship endpoint, a milestone or objective issue from another project, more than one parent per issue, and parent or blocking cycles. Rejections list up to 20 problems, and nothing is written.
- **Collisions.** Import always **copies**. Every record gets a new UUID, and references are rewritten to match, so an import never overwrites or merges with existing records, even when it is the same file imported twice.
- **Display IDs.** Imported issues get the next numbers of the active workspace, in the order of their original numbers. The report maps original keys to new ones.
- **Repairs.** Labels are matched to existing labels by name, ignoring case, and the report lists those reused names, because label names are unique in a workspace. A Done issue without `completedAt` gets the import time. A non-Done issue's `completedAt` is dropped, because only Done issues have one.
- **Transaction.** The import runs in one transaction. The preview runs the same steps and rolls back, so its report matches what the import does.

**CSV export.** `export_issues_csv` writes the list's current filters and sort (with every page) as CSV to a user-chosen location. Columns: Key, Title, Status, Priority, Project, Milestone, Labels, Start date, Due date, Completed at, Created at, Updated at, Archived. Fields are quoted per RFC 4180 (commas, quotes, and line breaks). Fields that a spreadsheet could run as a formula (starting with `=`, `+`, `-`, `@`, a tab, or a carriage return) are prefixed with `'`.

## Habits

Habits and their daily completions follow the [habit contract](HABITS.md), which also records how Ember data maps into a workspace and where Unhollowed differs from Ember.

## Daily check-ins

`daily_checkins` holds one optional, private record per workspace and local day (`YYYY-MM-DD`, compared as text), identified by `(workspace_id, date)` and a stable `id`.

- `mood`, `energy`, and `focus` are each a whole number from 1 to 5, or `NULL` when the user left them unset. Rust never fills in, averages, or defaults a rating. The note is optional, trimmed, and at most 2000 characters.
- **Saving replaces the whole record for the day**, in one upsert, so a cleared rating becomes unset. The record keeps its `id` and `created_at`; `updated_at` moves.
- **An empty submission** (no rating and a blank note) stores nothing: it deletes the day's record, and is a no-op when there is none. A table check also refuses an all-empty row.
- Past days can be edited at any time. A day after today cannot be saved, and dates before 1900 are refused.
- A record's day, ID, and workspace cannot change. Another workspace's record is neither visible nor changeable. `list_checkins` returns at most about ten years, oldest first, with absent days absent.
- Commands: `get_checkin`, `list_checkins`, `save_checkin`, `delete_checkin`.
- **Screen.** `/mood` has a date picker with previous, next, and Today (never past today), three radio groups where **Not set** is a visible, default choice, an optional note, and the last 60 days of check-ins. Choosing another day with unsaved changes is refused until they are saved or discarded. A failed save keeps the draft and shows the error. Saving with nothing chosen says that nothing was saved, or that the day's check-in was removed. The history list shows ratings only: a note's text appears only for the selected day.

## Check-in analytics

`get_checkin_analytics(from, to, withHabits)` summarizes recorded check-ins for a period of at most about ten years. Nothing is stored.

- **Independent averages.** Mood, energy, and focus are each averaged over the days that rated _that_ metric, and the number of those days (`samples`) is returned with every average. A day that rated only focus adds nothing to mood. A note-only day counts as a recorded day but adds no sample.
- **Gaps stay gaps.** `average` is `null`, never `0`, when no day in a period rated the metric. `points` lists recorded days only. Charts draw a mark only for a rated day and join two marks only when they are on consecutive days.
- **Periods.** `weeks` run Monday to Sunday and `months` are calendar months, clipped to the period. They are the same buckets the habit statistics use, so the optional habit side (`habits`: eligible, completed, percent) aligns by construction. Without `withHabits` it is `null`. The period is counted through today.
- **No composite.** The three metrics are never combined into a score, and the comparison with habit completion is shown side by side with no claim that one affects the other.
- **Screen.** `/mood` shows Trends under the check-in: Last 30, 90, or 365 days, a tile per metric ("3.7 of 5 (3 days)"), a 1 to 5 chart per metric with a data table, weekly and monthly tables, and an opt-in habit completion column.

## Migrations

- Files are `src-tauri/migrations/NNNN_description.sql`, numbered in order and registered in `migrations()`. A test fails if a file and the registered list disagree.
- Migrations are forward-only. Never edit or delete one that has shipped, because existing databases record its checksum.
- Prefer additive changes. Tables are `STRICT`. If a change needs a table rebuild, copy data in the same migration and test it against a fixture that contains rows.
- Test every migration on a fresh database and on an upgraded database that started from the previous schema. Use disposable databases only. Never reset a user's database to make a test pass.

## Current schema

| Migration | Adds                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------- |
| 0001      | `workspaces` and the seeded Personal workspace                                                            |
| 0002      | `app_state`, pointing at the Personal workspace for existing and new databases                            |
| 0003      | `documents`, owned by a workspace, with Tiptap JSON content                                               |
| 0004      | `projects`, owned by a workspace, with status and optional dates                                          |
| 0005      | `issues` and `issue_counters`, with per-workspace numbers and optional project                            |
| 0006      | `issues.search_text` for literal, case-insensitive issue search                                           |
| 0007      | `labels` and `issue_labels`, with unique links and archived-label rules                                   |
| 0008      | `milestones` and `issues.milestone_id`, with project compatibility triggers                               |
| 0009      | Project missions, objectives, and objective-to-issue links                                                |
| 0010      | Workspace-scoped issue relationships                                                                      |
| 0011      | `issue_recurrences` and occurrence identity on issues                                                     |
| 0012      | `saved_views` with versioned filter configuration                                                         |
| 0013      | `issue_documents` and `project_documents` links                                                           |
| 0014      | `issues.archived_at`, separate from the issue lifecycle                                                   |
| 0015      | Local document revision checkpoints                                                                       |
| 0016      | Private document image assets                                                                             |
| 0017      | Document folders and library metadata                                                                     |
| 0018      | Workspace document reference index                                                                        |
| 0019      | Workspace document text index for local search                                                            |
| 0020      | `calendars`, `events`, and `work_blocks`, with same-workspace triggers ([calendar contract](CALENDAR.md)) |
| 0021      | `scheduling_state`, the time-zone database release calendar instants were resolved with                   |
| 0022      | Event repeat rules and `event_exceptions` for changed or canceled occurrences                             |
| 0023      | Event links to documents and projects                                                                     |
| 0024      | `event_reminders`, `reminder_settings`, and `reminder_deliveries`                                         |
| 0025      | `events.ics_uid`, the iCalendar UID an event was imported with                                            |
| 0026      | `habits` and `habit_completions`, with same-workspace triggers ([habit contract](HABITS.md))              |
| 0027      | `daily_checkins`: optional 1 to 5 mood, energy, and focus and a note, one per workspace and day           |
| 0028      | `habit_events`: links from habits to recurring events, with same-workspace and recurring-event triggers   |
