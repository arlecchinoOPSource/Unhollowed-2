-- Issues are workspace-owned units of work. Each has a stable UUID and a
-- readable number (shown as ISS-<number>) that is unique within its workspace
-- and never reused, even after the issue moves between projects or is deleted.

-- The last number handed out per workspace. Rust increments this in the same
-- transaction that inserts the issue, so numbers only ever increase.
CREATE TABLE issue_counters (
    workspace_id TEXT NOT NULL PRIMARY KEY REFERENCES workspaces (id) ON DELETE RESTRICT,
    last_number INTEGER NOT NULL CHECK (last_number > 0)
) STRICT;

CREATE TABLE issues (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    number INTEGER NOT NULL CHECK (number > 0),
    -- Optional. Issues without a project belong to the workspace Inbox.
    project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    -- Tiptap (ProseMirror) JSON, stored as text like document content.
    description TEXT NOT NULL CHECK (json_valid(description)),
    status TEXT NOT NULL DEFAULT 'todo'
        CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'canceled')),
    priority TEXT NOT NULL DEFAULT 'none'
        CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
    -- Local calendar dates in YYYY-MM-DD form.
    start_date TEXT,
    due_date TEXT,
    -- UTC ISO 8601. Set only while the issue is done.
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Open or closed is derived from status and never stored separately.
    closed INTEGER GENERATED ALWAYS AS (status IN ('done', 'canceled')) VIRTUAL,
    UNIQUE (workspace_id, number),
    CHECK (start_date <= due_date),
    CHECK (completed_at IS NULL OR status = 'done')
) STRICT;

CREATE INDEX issues_by_workspace ON issues (workspace_id, updated_at DESC);
CREATE INDEX issues_by_project ON issues (workspace_id, project_id, updated_at DESC);

-- A project link must stay inside the issue's workspace. Rust checks this in
-- every write command, and these triggers keep the database consistent too.
CREATE TRIGGER issues_project_workspace_insert
BEFORE INSERT ON issues
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM projects WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'issue project belongs to another workspace');
END;

CREATE TRIGGER issues_project_workspace_update
BEFORE UPDATE OF project_id, workspace_id ON issues
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM projects WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'issue project belongs to another workspace');
END;
