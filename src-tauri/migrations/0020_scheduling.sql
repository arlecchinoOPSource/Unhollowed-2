-- Phase 3 scheduling. docs/CALENDAR.md describes the contract.
--
-- Three kinds of calendar item have distinct storage:
--   * events: rows in `events`, owned by a calendar;
--   * issue deadlines: projected from `issues.due_date`, with no rows here;
--   * work blocks: rows in `work_blocks`, each tied to one issue.
--
-- Timed rows keep the user's intent (wall-clock times in an IANA zone) and
-- the resolved UTC instants that range queries use. All-day rows keep
-- calendar dates. Ranges are half-open: end is exclusive.

CREATE TABLE calendars (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    description TEXT CHECK (description IS NULL OR length(description) <= 500),
    color TEXT NOT NULL CHECK (
        color IN ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink')
    ),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- The default calendar is always active.
    CHECK (is_default = 0 OR archived_at IS NULL)
) STRICT;

-- At most one default per workspace. Rust creates it on first use.
CREATE UNIQUE INDEX calendars_one_default ON calendars (workspace_id) WHERE is_default = 1;
CREATE INDEX calendars_by_workspace ON calendars (workspace_id, archived_at, name);

CREATE TRIGGER calendars_workspace_fixed
BEFORE UPDATE OF workspace_id ON calendars
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN
    SELECT RAISE(ABORT, 'calendar workspace cannot change');
END;

CREATE TABLE events (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    calendar_id TEXT NOT NULL REFERENCES calendars (id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
    location TEXT CHECK (location IS NULL OR length(location) <= 200),
    url TEXT CHECK (url IS NULL OR length(url) <= 2000),
    all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
    -- All-day: YYYY-MM-DD, end exclusive.
    start_date TEXT,
    end_date TEXT,
    -- Timed: IANA zone, wall-clock YYYY-MM-DDTHH:MM in that zone, and the
    -- resolved UTC instants as YYYY-MM-DDTHH:MM:SSZ, end exclusive.
    time_zone TEXT,
    start_local TEXT,
    end_local TEXT,
    start_at TEXT,
    end_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
        (all_day = 1
            AND start_date IS NOT NULL AND end_date IS NOT NULL AND end_date > start_date
            AND time_zone IS NULL AND start_local IS NULL AND end_local IS NULL
            AND start_at IS NULL AND end_at IS NULL)
        OR (all_day = 0
            AND start_date IS NULL AND end_date IS NULL
            AND time_zone IS NOT NULL AND start_local IS NOT NULL AND end_local IS NOT NULL
            AND start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at)
    )
) STRICT;

CREATE INDEX events_timed_range ON events (workspace_id, start_at, end_at) WHERE all_day = 0;
CREATE INDEX events_dated_range ON events (workspace_id, start_date, end_date) WHERE all_day = 1;
CREATE INDEX events_by_calendar ON events (calendar_id);

CREATE TRIGGER events_calendar_workspace_insert
BEFORE INSERT ON events
WHEN NOT EXISTS (
    SELECT 1 FROM calendars WHERE id = NEW.calendar_id AND workspace_id = NEW.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'event calendar belongs to another workspace');
END;

CREATE TRIGGER events_calendar_workspace_update
BEFORE UPDATE OF calendar_id, workspace_id ON events
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NOT EXISTS (
    SELECT 1 FROM calendars WHERE id = NEW.calendar_id AND workspace_id = NEW.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'event calendar belongs to another workspace');
END;

-- Time set aside to work on an issue. Deleting the issue deletes its blocks.
CREATE TABLE work_blocks (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
    time_zone TEXT NOT NULL,
    start_local TEXT NOT NULL,
    end_local TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (end_at > start_at)
) STRICT;

CREATE INDEX work_blocks_range ON work_blocks (workspace_id, start_at, end_at);
CREATE INDEX work_blocks_by_issue ON work_blocks (issue_id);

CREATE TRIGGER work_blocks_issue_workspace_insert
BEFORE INSERT ON work_blocks
WHEN NOT EXISTS (
    SELECT 1 FROM issues WHERE id = NEW.issue_id AND workspace_id = NEW.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'work block issue belongs to another workspace');
END;

CREATE TRIGGER work_blocks_scope_fixed
BEFORE UPDATE OF workspace_id, issue_id ON work_blocks
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.issue_id IS NOT OLD.issue_id
BEGIN
    SELECT RAISE(ABORT, 'work block scope cannot change');
END;
