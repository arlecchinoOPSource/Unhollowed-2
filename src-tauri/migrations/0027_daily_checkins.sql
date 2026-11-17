-- Phase 4 daily check-ins. docs/DATA_MODEL.md describes the contract.
--
-- One optional, private check-in per workspace and local calendar day
-- (`YYYY-MM-DD`, compared as text). Mood, energy, and focus are each a whole
-- number from 1 to 5, or NULL when the user chose not to say. Nothing is ever
-- filled in for them. A check-in with no rating and no note is not stored;
-- saving one deletes the day's record.

CREATE TABLE daily_checkins (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    date TEXT NOT NULL CHECK (date IS strftime('%Y-%m-%d', date)),
    mood INTEGER CHECK (mood IS NULL OR mood BETWEEN 1 AND 5),
    energy INTEGER CHECK (energy IS NULL OR energy BETWEEN 1 AND 5),
    focus INTEGER CHECK (focus IS NULL OR focus BETWEEN 1 AND 5),
    note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (mood IS NOT NULL OR energy IS NOT NULL OR focus IS NOT NULL OR note IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX daily_checkins_day ON daily_checkins (workspace_id, date);

CREATE TRIGGER daily_checkins_identity_fixed
BEFORE UPDATE OF id, workspace_id, date ON daily_checkins
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.date IS NOT OLD.date
BEGIN
    SELECT RAISE(ABORT, 'check-in identity cannot change');
END;
