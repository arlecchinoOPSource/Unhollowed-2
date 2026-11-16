-- Milestones are checkpoints for a whole workspace or for one project.
CREATE TABLE milestones (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    -- NULL for a workspace milestone. A project with milestones cannot be
    -- deleted until a later issue defines what happens to them.
    project_id TEXT REFERENCES projects (id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    description TEXT CHECK (length(description) <= 5000),
    -- Local calendar date in YYYY-MM-DD form.
    due_date TEXT,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    -- UTC ISO 8601. Set only while the milestone is closed.
    closed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (closed_at IS NULL OR state = 'closed')
) STRICT;

CREATE INDEX milestones_by_workspace ON milestones (workspace_id, project_id, state);

-- A project milestone must belong to a project in the same workspace.
CREATE TRIGGER milestones_project_workspace
BEFORE INSERT ON milestones
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM projects WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id
)
BEGIN
    SELECT RAISE(ABORT, 'milestone project belongs to another workspace');
END;

CREATE TRIGGER milestones_scope_fixed
BEFORE UPDATE OF workspace_id, project_id ON milestones
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.project_id IS NOT OLD.project_id
BEGIN
    SELECT RAISE(ABORT, 'milestone scope cannot change');
END;

-- Each issue has at most one milestone. Deleting a milestone clears it.
ALTER TABLE issues ADD COLUMN milestone_id TEXT REFERENCES milestones (id) ON DELETE SET NULL;

CREATE INDEX issues_by_milestone ON issues (workspace_id, milestone_id);

-- An issue's milestone must be in its workspace and be either a workspace
-- milestone or one for the issue's own project.
CREATE TRIGGER issues_milestone_insert
BEFORE INSERT ON issues
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM milestones
    WHERE id = NEW.milestone_id AND workspace_id = NEW.workspace_id
      AND (project_id IS NULL OR project_id IS NEW.project_id)
)
BEGIN
    SELECT RAISE(ABORT, 'issue milestone is not compatible');
END;

CREATE TRIGGER issues_milestone_update
BEFORE UPDATE OF milestone_id, project_id, workspace_id ON issues
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM milestones
    WHERE id = NEW.milestone_id AND workspace_id = NEW.workspace_id
      AND (project_id IS NULL OR project_id IS NEW.project_id)
)
BEGIN
    SELECT RAISE(ABORT, 'issue milestone is not compatible');
END;
