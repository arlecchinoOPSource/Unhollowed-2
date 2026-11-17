-- Links from habits to the recurring calendar events they happen with. A link
-- is a row of its own holding only the two IDs, so a renamed or archived habit
-- keeps its link and nothing is copied. Unlinking removes only the row.
-- A link cannot exist without both ends, so deleting the habit or the event
-- removes its links (ON DELETE CASCADE) and never the other record.
-- Archiving a habit keeps its links. The event owns the schedule: a link says
-- nothing about completion, and no occurrence ever writes a completion.
CREATE TABLE habit_events (
    habit_id TEXT NOT NULL REFERENCES habits (id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (habit_id, event_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX habit_events_by_event ON habit_events (workspace_id, event_id);

-- Both ends belong to the link's workspace, and the event repeats.
CREATE TRIGGER habit_events_same_workspace
BEFORE INSERT ON habit_events
WHEN NOT EXISTS (SELECT 1 FROM habits WHERE id = NEW.habit_id AND workspace_id = NEW.workspace_id)
  OR NOT EXISTS (SELECT 1 FROM events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id)
BEGIN
    SELECT RAISE(ABORT, 'habit and event must share the workspace');
END;

CREATE TRIGGER habit_events_recurring
BEFORE INSERT ON habit_events
WHEN NOT EXISTS (SELECT 1 FROM events WHERE id = NEW.event_id AND repeat_freq IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'only a recurring event can be a routine');
END;
