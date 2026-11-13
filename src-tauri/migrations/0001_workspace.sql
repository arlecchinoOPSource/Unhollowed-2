CREATE TABLE workspaces (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0)
) STRICT;

INSERT INTO workspaces (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'Personal');
