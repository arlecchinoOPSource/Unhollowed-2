-- Records which workspace the app opens. The Phase 0 workspace stays untouched,
-- so existing databases keep their Personal workspace and its stable ID.
CREATE TABLE app_state (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    active_workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT
) STRICT;

INSERT INTO app_state (singleton, active_workspace_id)
VALUES (1, '00000000-0000-4000-8000-000000000001');
