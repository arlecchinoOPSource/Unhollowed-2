-- Links from calendar events to existing documents and projects. A link is a
-- row of its own that holds only the two IDs, so a renamed or archived record
-- keeps its link and nothing is copied. Unlinking removes only the row. A link
-- cannot exist without both ends, so deleting the event, document, or project
-- removes its links (ON DELETE CASCADE) and never the other record. A link
-- belongs to the event, so every occurrence of a repeating event shares it.
CREATE TABLE event_documents (
    event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (event_id, document_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE event_projects (
    event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (event_id, project_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX event_documents_by_document ON event_documents (workspace_id, document_id);
CREATE INDEX event_projects_by_project ON event_projects (workspace_id, project_id);

-- Both ends belong to the link's workspace.
CREATE TRIGGER event_documents_same_workspace
BEFORE INSERT ON event_documents
WHEN NOT EXISTS (SELECT 1 FROM events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id)
  OR NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND workspace_id = NEW.workspace_id)
BEGIN
    SELECT RAISE(ABORT, 'event and document must share the workspace');
END;

CREATE TRIGGER event_projects_same_workspace
BEFORE INSERT ON event_projects
WHEN NOT EXISTS (SELECT 1 FROM events WHERE id = NEW.event_id AND workspace_id = NEW.workspace_id)
  OR NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id)
BEGIN
    SELECT RAISE(ABORT, 'event and project must share the workspace');
END;

CREATE TRIGGER event_documents_no_update BEFORE UPDATE ON event_documents
BEGIN
    SELECT RAISE(ABORT, 'event links are removed and added, not edited');
END;

CREATE TRIGGER event_projects_no_update BEFORE UPDATE ON event_projects
BEGIN
    SELECT RAISE(ABORT, 'event links are removed and added, not edited');
END;
