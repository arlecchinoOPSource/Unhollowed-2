-- Links from issues and projects to existing documents. Links never change
-- document content. A link cannot exist without both ends, so it is removed
-- with either (ON DELETE CASCADE); unlinking removes only the link row.
CREATE TABLE issue_documents (
    issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (issue_id, document_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE project_documents (
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (project_id, document_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX issue_documents_by_document ON issue_documents (workspace_id, document_id);
CREATE INDEX project_documents_by_document ON project_documents (workspace_id, document_id);

-- Both ends belong to the link's workspace.
CREATE TRIGGER issue_documents_same_workspace
BEFORE INSERT ON issue_documents
WHEN NOT EXISTS (SELECT 1 FROM issues WHERE id = NEW.issue_id AND workspace_id = NEW.workspace_id)
  OR NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND workspace_id = NEW.workspace_id)
BEGIN
    SELECT RAISE(ABORT, 'issue and document must share the workspace');
END;

CREATE TRIGGER project_documents_same_workspace
BEFORE INSERT ON project_documents
WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id)
  OR NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND workspace_id = NEW.workspace_id)
BEGIN
    SELECT RAISE(ABORT, 'project and document must share the workspace');
END;

CREATE TRIGGER issue_documents_no_update BEFORE UPDATE ON issue_documents
BEGIN
    SELECT RAISE(ABORT, 'document links are removed and added, not edited');
END;

CREATE TRIGGER project_documents_no_update BEFORE UPDATE ON project_documents
BEGIN
    SELECT RAISE(ABORT, 'document links are removed and added, not edited');
END;
