-- Dashboard layouts. A dashboard is a name and a versioned layout: widget
-- instances with their type, config, position, and size, plus the period the
-- dashboard shows. No analytics values are stored; every widget reads its
-- numbers from the authoritative queries when it is shown.
CREATE TABLE dashboards (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    -- The name lowercased by Rust, so names differing only in case clash.
    name_key TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    -- The layout format, for forward migrations. Rust writes 1. A larger
    -- value was written by a newer release and is read back but never
    -- overwritten by this one.
    layout_version INTEGER NOT NULL CHECK (layout_version >= 1),
    layout TEXT NOT NULL CHECK (json_valid(layout)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (workspace_id, name_key)
) STRICT;

CREATE INDEX dashboards_by_workspace ON dashboards (workspace_id, position, name_key);
