-- Recurring issues. A rule describes the schedule; each occurrence is an
-- ordinary issue that records its series and its index in that series.
CREATE TABLE issue_recurrences (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
    -- Every N days, weeks, or months.
    interval_count INTEGER NOT NULL CHECK (interval_count BETWEEN 1 AND 99),
    -- The local date of occurrence 0. Every occurrence date is computed
    -- from it, so month-end dates do not drift.
    anchor_date TEXT NOT NULL,
    -- UTC ISO 8601. A stopped series creates no more occurrences.
    stopped_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Deleting a series leaves its issues as ordinary issues.
ALTER TABLE issues ADD COLUMN recurrence_id TEXT
    REFERENCES issue_recurrences (id) ON DELETE SET NULL;
ALTER TABLE issues ADD COLUMN occurrence_index INTEGER CHECK (occurrence_index >= 0);

-- Durable occurrence identity: occurrence N of a series exists at most once.
CREATE UNIQUE INDEX issues_by_occurrence ON issues (recurrence_id, occurrence_index);

-- The series and its index are set together, and the series belongs to the
-- issue's workspace.
CREATE TRIGGER issues_recurrence_insert
BEFORE INSERT ON issues
WHEN (NEW.recurrence_id IS NULL) != (NEW.occurrence_index IS NULL)
  OR (NEW.recurrence_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM issue_recurrences
      WHERE id = NEW.recurrence_id AND workspace_id = NEW.workspace_id))
BEGIN
    SELECT RAISE(ABORT, 'issue recurrence is not valid');
END;

CREATE TRIGGER issues_recurrence_update
BEFORE UPDATE OF recurrence_id, occurrence_index, workspace_id ON issues
WHEN NEW.recurrence_id IS NOT NULL AND (NEW.occurrence_index IS NULL OR NOT EXISTS (
      SELECT 1 FROM issue_recurrences
      WHERE id = NEW.recurrence_id AND workspace_id = NEW.workspace_id))
BEGIN
    SELECT RAISE(ABORT, 'issue recurrence is not valid');
END;
