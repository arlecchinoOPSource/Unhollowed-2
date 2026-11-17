-- Phase 4 habits. docs/HABITS.md describes the contract and the Ember port.
--
-- Dates are local calendar days, `YYYY-MM-DD`, compared as text. A habit is
-- eligible from `start_date` through `archived_on`, inclusive. A completion
-- row means done; no row means not done. Eligibility depends on today, so
-- Rust checks it on every write.

CREATE TABLE habits (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
    name_key TEXT NOT NULL CHECK (name_key = lower(trim(name))),
    position INTEGER NOT NULL CHECK (position >= 0),
    start_date TEXT NOT NULL CHECK (start_date IS strftime('%Y-%m-%d', start_date)),
    -- The last eligible day, not a timestamp. NULL while the habit is active.
    archived_on TEXT CHECK (
        archived_on IS NULL
        OR (archived_on IS strftime('%Y-%m-%d', archived_on) AND archived_on >= start_date)
    ),
    -- Where an imported habit came from, and its ID there. Both NULL for
    -- habits made here.
    source TEXT CHECK (source IS NULL OR source = 'ember'),
    source_id TEXT CHECK (source_id IS NULL OR length(source_id) BETWEEN 1 AND 64),
    -- Raised by every write to the habit or its completions, so a reviewed
    -- deletion can tell whether anything changed since.
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((source IS NULL) = (source_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX habits_position ON habits (workspace_id, position);
CREATE UNIQUE INDEX habits_active_name ON habits (workspace_id, name_key) WHERE archived_on IS NULL;
CREATE UNIQUE INDEX habits_source ON habits (workspace_id, source, source_id) WHERE source_id IS NOT NULL;

CREATE TRIGGER habits_workspace_fixed
BEFORE UPDATE OF workspace_id ON habits
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN
    SELECT RAISE(ABORT, 'habit workspace cannot change');
END;

-- Completions cannot exist without their habit, so they are deleted with it.
-- Habits are deleted only through the reviewed deletion command.
CREATE TABLE habit_completions (
    habit_id TEXT NOT NULL REFERENCES habits (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    date TEXT NOT NULL CHECK (date IS strftime('%Y-%m-%d', date)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (habit_id, date)
) STRICT, WITHOUT ROWID;

CREATE INDEX habit_completions_by_date ON habit_completions (workspace_id, date);

CREATE TRIGGER habit_completions_same_workspace
BEFORE INSERT ON habit_completions
WHEN NOT EXISTS (SELECT 1 FROM habits WHERE id = NEW.habit_id AND workspace_id = NEW.workspace_id)
BEGIN
    SELECT RAISE(ABORT, 'habit belongs to another workspace');
END;

CREATE TRIGGER habit_completions_fixed
BEFORE UPDATE OF habit_id, workspace_id ON habit_completions
BEGIN
    SELECT RAISE(ABORT, 'completion owner cannot change');
END;
