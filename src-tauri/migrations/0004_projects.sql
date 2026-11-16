CREATE TABLE projects (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    description TEXT CHECK (length(description) <= 5000),
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'active', 'on_hold', 'completed', 'archived')),
    start_date TEXT,
    target_date TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (start_date <= target_date)
) STRICT;

CREATE INDEX projects_by_workspace ON projects (workspace_id, updated_at DESC);
