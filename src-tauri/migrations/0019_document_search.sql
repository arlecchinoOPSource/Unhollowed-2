CREATE TABLE document_index_ids (
    search_id INTEGER PRIMARY KEY,
    document_id TEXT NOT NULL UNIQUE REFERENCES documents (id) ON DELETE CASCADE
) STRICT;

CREATE VIRTUAL TABLE document_index USING fts5(
    document_id UNINDEXED,
    workspace_key,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIEW searchable_documents AS
SELECT d.id AS document_id, i.search_id, hex(d.workspace_id) AS workspace_key, d.title,
       COALESCE((SELECT group_concat(content.atom, ' ')
                 FROM json_tree(d.content) content
                 WHERE content.type = 'text' AND content.key IN ('text', 'caption', 'alt')), '') AS body
FROM documents d JOIN document_index_ids i ON i.document_id = d.id WHERE d.archived_at IS NULL;

INSERT INTO document_index_ids (document_id) SELECT id FROM documents;
INSERT INTO document_index (rowid, document_id, workspace_key, title, body)
SELECT search_id, document_id, workspace_key, title, body FROM searchable_documents;

CREATE TRIGGER document_index_insert AFTER INSERT ON documents
BEGIN
    INSERT INTO document_index_ids (document_id) VALUES (NEW.id);
    INSERT INTO document_index (rowid, document_id, workspace_key, title, body)
    SELECT search_id, document_id, workspace_key, title, body FROM searchable_documents WHERE document_id = NEW.id;
END;

CREATE TRIGGER document_index_update AFTER UPDATE OF title, content, archived_at ON documents
WHEN OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content OR OLD.archived_at IS NOT NEW.archived_at
BEGIN
    DELETE FROM document_index WHERE rowid = (SELECT search_id FROM document_index_ids WHERE document_id = OLD.id);
    INSERT INTO document_index (rowid, document_id, workspace_key, title, body)
    SELECT search_id, document_id, workspace_key, title, body FROM searchable_documents WHERE document_id = NEW.id;
END;

CREATE TRIGGER document_index_delete BEFORE DELETE ON documents
BEGIN
    DELETE FROM document_index WHERE rowid = (SELECT search_id FROM document_index_ids WHERE document_id = OLD.id);
END;
