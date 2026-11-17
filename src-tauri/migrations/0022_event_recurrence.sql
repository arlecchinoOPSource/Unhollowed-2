-- Recurring events and occurrence exceptions. docs/CALENDAR.md describes
-- the rules. Occurrences are computed when read, never stored; only
-- changes to individual occurrences are stored, keyed by the occurrence's
-- original start.

ALTER TABLE events ADD COLUMN repeat_freq TEXT
    CHECK (repeat_freq IS NULL OR repeat_freq IN ('daily', 'weekly', 'monthly', 'yearly'));
ALTER TABLE events ADD COLUMN repeat_interval INTEGER
    CHECK (repeat_interval IS NULL OR repeat_interval BETWEEN 1 AND 99);
-- At most one limit: a number of occurrences or a last date (inclusive).
ALTER TABLE events ADD COLUMN repeat_count INTEGER
    CHECK (repeat_count IS NULL OR repeat_count BETWEEN 1 AND 999);
ALTER TABLE events ADD COLUMN repeat_until TEXT;

CREATE INDEX events_recurring ON events (workspace_id) WHERE repeat_freq IS NOT NULL;

CREATE TRIGGER events_repeat_insert
BEFORE INSERT ON events
WHEN (NEW.repeat_freq IS NULL AND (NEW.repeat_interval IS NOT NULL OR NEW.repeat_count IS NOT NULL OR NEW.repeat_until IS NOT NULL))
    OR (NEW.repeat_freq IS NOT NULL AND NEW.repeat_interval IS NULL)
    OR (NEW.repeat_count IS NOT NULL AND NEW.repeat_until IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'event repeat rule is incomplete');
END;

CREATE TRIGGER events_repeat_update
BEFORE UPDATE OF repeat_freq, repeat_interval, repeat_count, repeat_until ON events
WHEN (NEW.repeat_freq IS NULL AND (NEW.repeat_interval IS NOT NULL OR NEW.repeat_count IS NOT NULL OR NEW.repeat_until IS NOT NULL))
    OR (NEW.repeat_freq IS NOT NULL AND NEW.repeat_interval IS NULL)
    OR (NEW.repeat_count IS NOT NULL AND NEW.repeat_until IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'event repeat rule is incomplete');
END;

-- A change to one occurrence of a recurring event. `occurrence` is the
-- occurrence's original start: YYYY-MM-DD for all-day series, or the
-- wall-clock YYYY-MM-DDTHH:MM in the event's zone for timed series. It
-- never changes, so a moved occurrence keeps its identity.
CREATE TABLE event_exceptions (
    event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    occurrence TEXT NOT NULL,
    canceled INTEGER NOT NULL DEFAULT 0 CHECK (canceled IN (0, 1)),
    -- Overrides. NULL keeps the series value.
    title TEXT CHECK (title IS NULL OR length(trim(title)) BETWEEN 1 AND 200),
    description TEXT CHECK (description IS NULL OR length(description) <= 10000),
    location TEXT CHECK (location IS NULL OR length(location) <= 200),
    url TEXT CHECK (url IS NULL OR length(url) <= 2000),
    -- A moved occurrence, in the series' representation.
    start_date TEXT,
    end_date TEXT,
    start_local TEXT,
    end_local TEXT,
    start_at TEXT,
    end_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (event_id, occurrence),
    CHECK (
        (start_date IS NULL AND end_date IS NULL) OR (start_date IS NOT NULL AND end_date > start_date)
    ),
    CHECK (
        (start_local IS NULL AND end_local IS NULL AND start_at IS NULL AND end_at IS NULL)
        OR (start_local IS NOT NULL AND end_local IS NOT NULL AND start_at IS NOT NULL AND end_at > start_at)
    )
) STRICT;

CREATE INDEX event_exceptions_moved_timed ON event_exceptions (start_at, end_at) WHERE start_at IS NOT NULL;
CREATE INDEX event_exceptions_moved_dated ON event_exceptions (start_date, end_date) WHERE start_date IS NOT NULL;
