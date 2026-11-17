-- The iCalendar UID an event was imported with. Events created here have no
-- value and are exported as `{id}@unhollowed-2`; imports match either form,
-- so importing a file twice, or a file exported from this app, finds the
-- event that already exists instead of adding a second copy.
ALTER TABLE events ADD COLUMN ics_uid TEXT
    CHECK (ics_uid IS NULL OR length(ics_uid) BETWEEN 1 AND 255);

CREATE UNIQUE INDEX events_ics_uid ON events (workspace_id, ics_uid) WHERE ics_uid IS NOT NULL;
