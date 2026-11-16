CREATE TABLE document_references (
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, source_id, target_id),
    CHECK (source_id <> target_id),
    FOREIGN KEY (workspace_id, source_id) REFERENCES documents (workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, target_id) REFERENCES documents (workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX document_backlinks ON document_references (workspace_id, target_id, source_id);

-- Only Tiptap marks with a matching document in this workspace become edges.
CREATE VIEW document_reference_marks AS
SELECT d.workspace_id, d.id AS source_id,
       json_extract(mark.value, '$.attrs.targetId') AS target_id
FROM documents d, json_tree(d.content) marks, json_each(CASE WHEN marks.type = 'array' THEN marks.value END) mark
WHERE marks.key = 'marks' AND marks.type = 'array'
  AND CASE WHEN mark.type = 'object' THEN json_extract(mark.value, '$.type') END = 'documentReference';

CREATE TRIGGER insert_document_references AFTER INSERT ON documents
BEGIN
    INSERT OR IGNORE INTO document_references
    SELECT refs.workspace_id, refs.source_id, refs.target_id
    FROM document_reference_marks refs
    JOIN documents target ON target.workspace_id = refs.workspace_id AND target.id = refs.target_id
    WHERE refs.workspace_id = NEW.workspace_id AND refs.source_id = NEW.id AND refs.source_id <> refs.target_id;
END;

CREATE TRIGGER update_document_references AFTER UPDATE OF content ON documents
WHEN OLD.content <> NEW.content
BEGIN
    DELETE FROM document_references WHERE workspace_id = NEW.workspace_id AND source_id = NEW.id;
    INSERT OR IGNORE INTO document_references
    SELECT refs.workspace_id, refs.source_id, refs.target_id
    FROM document_reference_marks refs
    JOIN documents target ON target.workspace_id = refs.workspace_id AND target.id = refs.target_id
    WHERE refs.workspace_id = NEW.workspace_id AND refs.source_id = NEW.id AND refs.source_id <> refs.target_id;
END;
