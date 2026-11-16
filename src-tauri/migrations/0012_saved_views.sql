-- Saved issue views: a name and a versioned filter configuration.
CREATE TABLE saved_views (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    -- The name lowercased by Rust, so names differing only in case clash.
    name_key TEXT NOT NULL,
    -- The configuration format, for forward migrations. Rust writes 1.
    config_version INTEGER NOT NULL CHECK (config_version >= 1),
    -- JSON: { "version", "view": "list" | "board", "filters": { ... } }.
    -- Filters keep relative rules such as "overdue", never resolved dates.
    config TEXT NOT NULL CHECK (json_valid(config)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (workspace_id, name_key)
) STRICT;
