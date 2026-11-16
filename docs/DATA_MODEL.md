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
