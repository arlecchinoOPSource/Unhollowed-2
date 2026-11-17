-- Local reminders for calendar events. A reminder is one offset before an
-- event's start, kept apart from the event so editing never rewrites it.
-- Deleting the event removes its reminder and delivery records.
CREATE TABLE event_reminders (
    event_id TEXT NOT NULL PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    minutes_before INTEGER NOT NULL CHECK (minutes_before BETWEEN 0 AND 10080),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER event_reminders_same_workspace
BEFORE INSERT ON event_reminders
WHEN NOT EXISTS (SELECT 1 FROM events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id)
BEGIN
    SELECT RAISE(ABORT, 'reminder event belongs to another workspace');
END;

-- One row per workspace, created when reminders are first turned off. A
-- workspace without a row has reminders on.
CREATE TABLE reminder_settings (
    workspace_id TEXT NOT NULL PRIMARY KEY REFERENCES workspaces (id) ON DELETE RESTRICT,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
) STRICT;

-- A delivery is identified by the event, which occurrence of it, the start
-- the reminder was for, and the offset. Moving an event changes its start,
-- so the new time is reminded once more, while a restart never repeats a
-- delivery that already happened.
CREATE TABLE reminder_deliveries (
    event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    occurrence TEXT NOT NULL,
    start_at TEXT NOT NULL,
    minutes_before INTEGER NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    delivered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (event_id, occurrence, start_at, minutes_before)
) STRICT, WITHOUT ROWID;

CREATE INDEX reminder_deliveries_by_start ON reminder_deliveries (workspace_id, start_at);
