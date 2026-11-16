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

Documents are read and written only through the `list_documents`, `get_document`, `create_document`, and `update_document` commands in `src-tauri/src/documents.rs`. The webview never sends a workspace ID. Rust resolves the active workspace, and every query filters by it, so an ID from another workspace returns `not_found` exactly like an ID that does not exist.

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

## Migrations

- Files are `src-tauri/migrations/NNNN_description.sql`, numbered in order and registered in `migrations()`. A test fails if a file and the registered list disagree.
- Migrations are forward-only. Never edit or delete one that has shipped, because existing databases record its checksum.
- Prefer additive changes. Tables are `STRICT`. If a change needs a table rebuild, copy data in the same migration and test it against a fixture that contains rows.
- Test every migration on a fresh database and on an upgraded database that started from the previous schema. Use disposable databases only. Never reset a user's database to make a test pass.

## Current schema

| Migration | Adds                                                                           |
| --------- | ------------------------------------------------------------------------------ |
| 0001      | `workspaces` and the seeded Personal workspace                                 |
| 0002      | `app_state`, pointing at the Personal workspace for existing and new databases |
| 0003      | `documents`, owned by a workspace, with Tiptap JSON content                    |
| 0004      | `projects`, owned by a workspace, with status and optional dates               |
| 0005      | `issues` and `issue_counters`, with per-workspace numbers and optional project |
| 0006      | `issues.search_text` for literal, case-insensitive issue search                |
| 0007      | `labels` and `issue_labels`, with unique links and archived-label rules        |
