-- Documents belong to one workspace. Content is Tiptap (ProseMirror) JSON
-- stored as text so formatting round-trips exactly.
CREATE TABLE documents (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    content TEXT NOT NULL CHECK (json_valid(content)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX documents_by_workspace ON documents (workspace_id, updated_at DESC);
