-- Project ownership supplies the workspace for each goal.
CREATE TABLE missions (
    id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    description TEXT NOT NULL CHECK (length(description) <= 5000)
) STRICT;
CREATE INDEX missions_by_project ON missions (project_id);

CREATE TABLE objectives (
    id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    mission_id TEXT REFERENCES missions (id) ON DELETE SET NULL,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    description TEXT NOT NULL CHECK (length(description) <= 5000)
) STRICT;
CREATE INDEX objectives_by_project ON objectives (project_id);

CREATE TABLE objective_issues (
    objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
    issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
    PRIMARY KEY (objective_id, issue_id)
) STRICT;
CREATE INDEX objective_links_by_issue ON objective_issues (issue_id);

CREATE TRIGGER objective_mission_insert BEFORE INSERT ON objectives
WHEN NEW.mission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM missions WHERE id = NEW.mission_id AND project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'mission must belong to the project'); END;

CREATE TRIGGER objective_mission_update BEFORE UPDATE OF mission_id, project_id ON objectives
WHEN NEW.mission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM missions WHERE id = NEW.mission_id AND project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'mission must belong to the project'); END;

CREATE TRIGGER objective_issue_insert BEFORE INSERT ON objective_issues
WHEN NOT EXISTS (
    SELECT 1 FROM objectives AS o
    JOIN projects AS p ON p.id = o.project_id
    JOIN issues AS i ON i.project_id = p.id AND i.workspace_id = p.workspace_id
    WHERE o.id = NEW.objective_id AND i.id = NEW.issue_id
)
BEGIN SELECT RAISE(ABORT, 'issue must belong to the project'); END;

-- A move removes links to goals in the original project.
CREATE TRIGGER objective_issue_on_move AFTER UPDATE OF project_id ON issues
WHEN NEW.project_id IS NOT OLD.project_id
BEGIN DELETE FROM objective_issues WHERE issue_id = NEW.id; END;
