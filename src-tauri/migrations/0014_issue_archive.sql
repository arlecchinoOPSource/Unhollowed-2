-- Archiving is separate from the issue lifecycle: an archived issue keeps
-- its status and every link, and restoring clears this column only.
ALTER TABLE issues ADD COLUMN archived_at TEXT;
