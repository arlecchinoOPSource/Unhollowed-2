CREATE UNIQUE INDEX documents_workspace_identity ON documents (workspace_id, id);

CREATE TABLE document_revisions (
    id INTEGER PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL CHECK (json_valid(content)),
    saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (workspace_id, document_id) REFERENCES documents (workspace_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX document_revisions_lookup ON document_revisions (workspace_id, document_id, id DESC);

-- Save the prior version at most once every five minutes of editing.
CREATE TRIGGER document_checkpoint BEFORE UPDATE OF title, content ON documents
WHEN (OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content)
  AND NOT EXISTS (
    SELECT 1 FROM document_revisions
    WHERE workspace_id = OLD.workspace_id AND document_id = OLD.id
      AND saved_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
)
BEGIN
    INSERT INTO document_revisions (workspace_id, document_id, title, content)
    VALUES (OLD.workspace_id, OLD.id, OLD.title, OLD.content);
END;

CREATE TRIGGER trim_document_revisions AFTER INSERT ON document_revisions
BEGIN
    DELETE FROM document_revisions
    WHERE workspace_id = NEW.workspace_id AND document_id = NEW.document_id
      AND id IN (
        SELECT id FROM document_revisions
        WHERE workspace_id = NEW.workspace_id AND document_id = NEW.document_id
        ORDER BY id DESC LIMIT -1 OFFSET 20
      );
END;
