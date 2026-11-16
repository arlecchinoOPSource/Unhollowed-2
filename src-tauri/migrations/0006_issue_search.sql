-- Searchable text for issues: the title and the readable text of the Tiptap
-- description, lowercased with full Unicode rules. Rust computes it on every
-- write. Rows from before this migration start as NULL, and the first issue
-- query fills them in, because SQLite's lower() only folds ASCII.
ALTER TABLE issues ADD COLUMN search_text TEXT;

-- Supports the default sort and lets the lazy fill find unindexed rows.
CREATE INDEX issues_by_workspace_number ON issues (workspace_id, number);
