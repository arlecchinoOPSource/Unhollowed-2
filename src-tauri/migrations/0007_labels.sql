-- Workspace labels that group issues across projects.
CREATE TABLE labels (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 50),
    -- The name lowercased by Rust with full Unicode rules, so names differing
    -- only in case are duplicates. Archived labels keep their names reserved.
    name_key TEXT NOT NULL,
    description TEXT CHECK (length(description) <= 500),
    color TEXT NOT NULL CHECK (
        color IN ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink')
    ),
    -- UTC ISO 8601. Archived labels stay on issues but cannot be newly assigned.
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (workspace_id, name_key)
) STRICT;

-- Links between issues and labels. A link cannot exist without both its issue
-- and its label, so it is removed with either (ON DELETE CASCADE).
CREATE TABLE issue_labels (
    issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (issue_id, label_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX issue_labels_by_label ON issue_labels (workspace_id, label_id, issue_id);

-- Both ends of a link belong to the link's workspace, and archived labels
-- cannot be newly assigned. Removing a link is always allowed.
CREATE TRIGGER issue_labels_valid_insert
BEFORE INSERT ON issue_labels
BEGIN
    SELECT RAISE(ABORT, 'issue belongs to another workspace')
    WHERE NOT EXISTS (
        SELECT 1 FROM issues WHERE id = NEW.issue_id AND workspace_id = NEW.workspace_id
    );
    SELECT RAISE(ABORT, 'label belongs to another workspace')
    WHERE NOT EXISTS (
        SELECT 1 FROM labels WHERE id = NEW.label_id AND workspace_id = NEW.workspace_id
    );
    SELECT RAISE(ABORT, 'label is archived')
    WHERE EXISTS (SELECT 1 FROM labels WHERE id = NEW.label_id AND archived_at IS NOT NULL);
END;

CREATE TRIGGER issue_labels_no_update
BEFORE UPDATE ON issue_labels
BEGIN
    SELECT RAISE(ABORT, 'issue label links are replaced, not edited');
END;
