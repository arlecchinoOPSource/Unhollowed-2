CREATE TABLE document_folders (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    parent_id TEXT REFERENCES document_folders (id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    UNIQUE (workspace_id, id)
) STRICT;
CREATE INDEX document_folder_tree ON document_folders (workspace_id, parent_id);

CREATE TRIGGER document_folder_parent BEFORE INSERT ON document_folders
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_folders WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
)
BEGIN SELECT RAISE(ABORT, 'folder parent is not in workspace'); END;

ALTER TABLE documents ADD COLUMN folder_id TEXT REFERENCES document_folders (id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1));
ALTER TABLE documents ADD COLUMN archived_at TEXT;
ALTER TABLE documents ADD COLUMN opened_at TEXT;

CREATE TRIGGER document_folder_insert BEFORE INSERT ON documents
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_folders WHERE workspace_id = NEW.workspace_id AND id = NEW.folder_id
)
BEGIN SELECT RAISE(ABORT, 'document folder is not in workspace'); END;

CREATE TRIGGER document_folder_update BEFORE UPDATE OF folder_id, workspace_id ON documents
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_folders WHERE workspace_id = NEW.workspace_id AND id = NEW.folder_id
)
BEGIN SELECT RAISE(ABORT, 'document folder is not in workspace'); END;
