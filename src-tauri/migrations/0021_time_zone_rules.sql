-- The IANA time-zone database release that each workspace's stored UTC
-- instants were last resolved with. When the app bundles a newer release,
-- instants are re-resolved from their wall-clock intent, so events follow
-- updated daylight-saving rules. docs/CALENDAR.md explains the policy.
CREATE TABLE scheduling_state (
    workspace_id TEXT NOT NULL PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
    tzdb_version TEXT NOT NULL
) STRICT;
