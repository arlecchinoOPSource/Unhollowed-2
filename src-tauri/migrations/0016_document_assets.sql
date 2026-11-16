CREATE TABLE document_assets (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
    bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 8388608),
    FOREIGN KEY (workspace_id, document_id) REFERENCES documents (workspace_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX document_assets_by_document ON document_assets (workspace_id, document_id);
