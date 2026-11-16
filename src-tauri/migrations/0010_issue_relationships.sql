CREATE UNIQUE INDEX issues_by_id_and_workspace ON issues (id, workspace_id);

-- For parent links, source is the child. For blocks, source is the blocker.
-- Related links are stored once in lexical UUID order.
CREATE TABLE issue_relationships (
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('parent', 'blocks', 'related')),
    PRIMARY KEY (workspace_id, source_id, target_id, kind),
    FOREIGN KEY (source_id, workspace_id) REFERENCES issues (id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (target_id, workspace_id) REFERENCES issues (id, workspace_id) ON DELETE CASCADE,
    CHECK (source_id <> target_id),
    CHECK (kind <> 'related' OR source_id < target_id)
) STRICT;
CREATE UNIQUE INDEX issue_single_parent ON issue_relationships (workspace_id, source_id) WHERE kind = 'parent';
CREATE INDEX issue_relationships_by_target ON issue_relationships (workspace_id, target_id, kind);
