//! Project and issue data portability: versioned JSON export, validated
//! transactional import, and CSV export of issue lists. The format and the
//! collision and repair rules are in docs/DATA_MODEL.md under
//! "Data portability".

use crate::database::{active_workspace, pool, DatabaseError};
use crate::documents::is_rich_text;
use crate::issues::{search_text, IssueQuery, IssueSummary, PRIORITIES, STATUSES};
use crate::labels::COLORS;
use crate::projects::valid_date;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, State};
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

pub const FORMAT: &str = "unhollowed-2/projects";
pub const VERSION: i64 = 1;
/// Larger files are refused before parsing.
const MAX_IMPORT_BYTES: usize = 50 * 1024 * 1024;
/// Problems listed in a rejection; the total is reported too.
const MAX_PROBLEMS: usize = 20;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

#[derive(Clone, Debug, Deserialize, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableProject {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableLabel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub archived: bool,
}

#[derive(Clone, Debug, Deserialize, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableMilestone {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub due_date: Option<String>,
    pub closed: bool,
}

#[derive(Clone, Debug, Deserialize, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableMission {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableObjective {
    pub id: String,
    pub project_id: String,
    pub mission_id: Option<String>,
    pub title: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableIssue {
    pub id: String,
    /// The readable number in the exporting workspace.
    pub number: i64,
    pub project_id: Option<String>,
    pub milestone_id: Option<String>,
    pub title: String,
    /// Tiptap JSON, as stored.
    pub description: String,
    pub status: String,
    pub priority: String,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
}

#[derive(Clone, Debug, Deserialize, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableIssueLabel {
    pub issue_id: String,
    pub label_id: String,
}

#[derive(Clone, Debug, Deserialize, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableObjectiveIssue {
    pub objective_id: String,
    pub issue_id: String,
}

/// For `parent` the source is the child; for `blocks` the source blocks the
/// target; `related` is symmetric.
#[derive(Clone, Debug, Deserialize, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableRelationship {
    pub source_id: String,
    pub target_id: String,
    pub kind: String,
}

/// Version 1 of the export file.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectData {
    pub format: String,
    pub version: i64,
    pub exported_at: String,
    pub projects: Vec<PortableProject>,
    pub labels: Vec<PortableLabel>,
    pub milestones: Vec<PortableMilestone>,
    pub missions: Vec<PortableMission>,
    pub objectives: Vec<PortableObjective>,
    pub issues: Vec<PortableIssue>,
    pub issue_labels: Vec<PortableIssueLabel>,
    pub objective_issues: Vec<PortableObjectiveIssue>,
    pub relationships: Vec<PortableRelationship>,
}

/// What an import created or repaired. A preview returns the same report.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub projects: usize,
    pub labels_created: usize,
    /// Names of existing labels the import linked to instead of creating.
    pub labels_reused: Vec<String>,
    pub milestones: usize,
    pub missions: usize,
    pub objectives: usize,
    pub issues: usize,
    pub relationships: usize,
    /// Original key to new key, in original number order.
    pub renumbered: Vec<(String, String)>,
    /// Links to labels that are archived in this workspace, which cannot be
    /// newly assigned and were skipped.
    pub skipped_label_links: usize,
    /// Done issues without a completion time, which got the import time.
    pub completion_repaired: usize,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub path: String,
    pub records: usize,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum PortError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    /// The file is not valid JSON in the expected shape.
    UnreadableFile {
        detail: String,
    },
    /// The file parsed but failed validation; nothing was written.
    InvalidFile {
        problems: Vec<String>,
        total: usize,
    },
    TooLarge,
    InvalidFilter,
    WriteFailed,
    StorageFailed,
}

impl From<DatabaseError> for PortError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> PortError {
    eprintln!("Data portability storage failed: {error}");
    PortError::StorageFailed
}

/// Reads every exported record of the workspace.
pub async fn export(pool: &SqlitePool, workspace: &str) -> Result<ProjectData, PortError> {
    macro_rules! rows {
        ($sql:expr) => {
            sqlx::query_as($sql)
                .bind(workspace)
                .fetch_all(pool)
                .await
                .map_err(storage_failed)?
        };
    }
    let exported_at: String = sqlx::query_scalar(&format!("SELECT {NOW}"))
        .fetch_one(pool)
        .await
        .map_err(storage_failed)?;
    Ok(ProjectData {
        format: FORMAT.into(),
        version: VERSION,
        exported_at,
        projects: rows!(
            "SELECT id, name, description, status, start_date, target_date, created_at, updated_at
             FROM projects WHERE workspace_id = ? ORDER BY created_at, id"
        ),
        labels: rows!(
            "SELECT id, name, description, color, archived_at IS NOT NULL AS archived
             FROM labels WHERE workspace_id = ? ORDER BY name_key, id"
        ),
        milestones: rows!(
            "SELECT id, project_id, title, description, due_date, state = 'closed' AS closed
             FROM milestones WHERE workspace_id = ? ORDER BY created_at, id"
        ),
        missions: rows!(
            "SELECT m.id, m.project_id, m.title, m.description FROM missions AS m
             JOIN projects AS p ON p.id = m.project_id WHERE p.workspace_id = ? ORDER BY m.id"
        ),
        objectives: rows!(
            "SELECT o.id, o.project_id, o.mission_id, o.title, o.description FROM objectives AS o
             JOIN projects AS p ON p.id = o.project_id WHERE p.workspace_id = ? ORDER BY o.id"
        ),
        issues: rows!(
            "SELECT id, number, project_id, milestone_id, title, description, status, priority,
                    start_date, due_date, completed_at, created_at, updated_at,
                    archived_at IS NOT NULL AS archived
             FROM issues WHERE workspace_id = ? ORDER BY number"
        ),
        issue_labels: rows!(
            "SELECT issue_id, label_id FROM issue_labels WHERE workspace_id = ?
             ORDER BY issue_id, label_id"
        ),
        objective_issues: rows!(
            "SELECT l.objective_id, l.issue_id FROM objective_issues AS l
             JOIN objectives AS o ON o.id = l.objective_id
             JOIN projects AS p ON p.id = o.project_id
             WHERE p.workspace_id = ? ORDER BY l.objective_id, l.issue_id"
        ),
        relationships: rows!(
            "SELECT source_id, target_id, kind FROM issue_relationships
             WHERE workspace_id = ? ORDER BY kind, source_id, target_id"
        ),
    })
}

fn text_ok(value: &str, max: usize) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= max && !value.contains('\0')
}

fn optional_ok(value: &Option<String>, max: usize) -> bool {
    value
        .as_ref()
        .is_none_or(|value| value.chars().count() <= max && !value.contains('\0'))
}

fn dates_ok(start: &Option<String>, end: &Option<String>) -> bool {
    start.iter().chain(end).all(|date| valid_date(date))
        && match (start, end) {
            (Some(start), Some(end)) => start <= end,
            _ => true,
        }
}

/// True when following `edges` from any node can return to it.
fn has_cycle(edges: &HashMap<&str, Vec<&str>>) -> bool {
    fn visit<'a>(
        node: &'a str,
        edges: &HashMap<&'a str, Vec<&'a str>>,
        state: &mut HashMap<&'a str, u8>,
    ) -> bool {
        match state.get(node) {
            Some(1) => return true,
            Some(2) => return false,
            _ => {}
        }
        state.insert(node, 1);
        for next in edges.get(node).into_iter().flatten() {
            if visit(next, edges, state) {
                return true;
            }
        }
        state.insert(node, 2);
        false
    }
    let mut state = HashMap::new();
    edges.keys().any(|node| visit(node, edges, &mut state))
}

/// Checks the whole file without touching the database. Returns every
/// problem found, so the user can fix them in one pass.
pub fn validate(data: &ProjectData) -> Vec<String> {
    let mut problems = Vec::new();
    if data.format != FORMAT {
        problems.push(format!(
            "The file format is \"{}\", not \"{FORMAT}\".",
            data.format
        ));
        return problems;
    }
    if data.version != VERSION {
        problems.push(format!(
            "Version {} files are not supported. This app reads version {VERSION}.",
            data.version
        ));
        return problems;
    }
    let mut ids = HashSet::new();
    let mut unique = |kind: &str, id: &str, problems: &mut Vec<String>| {
        if !ids.insert(id.to_owned()) {
            problems.push(format!("The {kind} ID {id} appears more than once."));
        }
    };

    let projects: HashSet<&str> = data.projects.iter().map(|p| p.id.as_str()).collect();
    for project in &data.projects {
        unique("project", &project.id, &mut problems);
        if !text_ok(&project.name, 200)
            || !optional_ok(&project.description, 5000)
            || !matches!(
                project.status.as_str(),
                "planned" | "active" | "on_hold" | "completed" | "archived"
            )
            || !dates_ok(&project.start_date, &project.target_date)
        {
            problems.push(format!("Project {} has invalid values.", project.id));
        }
    }

    let mut label_names = HashSet::new();
    let labels: HashSet<&str> = data.labels.iter().map(|l| l.id.as_str()).collect();
    for label in &data.labels {
        unique("label", &label.id, &mut problems);
        if !text_ok(&label.name, 50)
            || !optional_ok(&label.description, 500)
            || !COLORS.contains(&label.color.as_str())
        {
            problems.push(format!("Label {} has invalid values.", label.id));
        }
        if !label_names.insert(label.name.trim().to_lowercase()) {
            problems.push(format!(
                "The label name \"{}\" appears more than once.",
                label.name
            ));
        }
    }

    let milestones: HashMap<&str, Option<&str>> = data
        .milestones
        .iter()
        .map(|m| (m.id.as_str(), m.project_id.as_deref()))
        .collect();
    for milestone in &data.milestones {
        unique("milestone", &milestone.id, &mut problems);
        if !text_ok(&milestone.title, 200)
            || !optional_ok(&milestone.description, 5000)
            || !dates_ok(&milestone.due_date, &None)
        {
            problems.push(format!("Milestone {} has invalid values.", milestone.id));
        }
        if let Some(project) = &milestone.project_id {
            if !projects.contains(project.as_str()) {
                problems.push(format!(
                    "Milestone {} refers to project {project}, which is not in the file.",
                    milestone.id
                ));
            }
        }
    }

    let missions: HashMap<&str, &str> = data
        .missions
        .iter()
        .map(|m| (m.id.as_str(), m.project_id.as_str()))
        .collect();
    for mission in &data.missions {
        unique("mission", &mission.id, &mut problems);
        if !text_ok(&mission.title, 200) || mission.description.chars().count() > 5000 {
            problems.push(format!("Mission {} has invalid values.", mission.id));
        }
        if !projects.contains(mission.project_id.as_str()) {
            problems.push(format!(
                "Mission {} refers to project {}, which is not in the file.",
                mission.id, mission.project_id
            ));
        }
    }

    let objectives: HashMap<&str, &str> = data
        .objectives
        .iter()
        .map(|o| (o.id.as_str(), o.project_id.as_str()))
        .collect();
    for objective in &data.objectives {
        unique("objective", &objective.id, &mut problems);
        if !text_ok(&objective.title, 200) || objective.description.chars().count() > 5000 {
            problems.push(format!("Objective {} has invalid values.", objective.id));
        }
        if !projects.contains(objective.project_id.as_str()) {
            problems.push(format!(
                "Objective {} refers to project {}, which is not in the file.",
                objective.id, objective.project_id
            ));
        }
        if let Some(mission) = &objective.mission_id {
            match missions.get(mission.as_str()) {
                None => problems.push(format!(
                    "Objective {} refers to mission {mission}, which is not in the file.",
                    objective.id
                )),
                Some(project) if *project != objective.project_id => problems.push(format!(
                    "Objective {} and its mission belong to different projects.",
                    objective.id
                )),
                _ => {}
            }
        }
    }

    let mut numbers = HashSet::new();
    let issues: HashMap<&str, Option<&str>> = data
        .issues
        .iter()
        .map(|i| (i.id.as_str(), i.project_id.as_deref()))
        .collect();
    for issue in &data.issues {
        unique("issue", &issue.id, &mut problems);
        if issue.number <= 0 || !numbers.insert(issue.number) {
            problems.push(format!(
                "Issue {} has a missing or repeated number.",
                issue.id
            ));
        }
        if !text_ok(&issue.title, 200)
            || !is_rich_text(&issue.description)
            || !STATUSES.contains(&issue.status.as_str())
            || !PRIORITIES.contains(&issue.priority.as_str())
            || !dates_ok(&issue.start_date, &issue.due_date)
        {
            problems.push(format!("Issue ISS-{} has invalid values.", issue.number));
        }
        if let Some(project) = &issue.project_id {
            if !projects.contains(project.as_str()) {
                problems.push(format!(
                    "Issue ISS-{} refers to project {project}, which is not in the file.",
                    issue.number
                ));
            }
        }
        if let Some(milestone) = &issue.milestone_id {
            match milestones.get(milestone.as_str()) {
                None => problems.push(format!(
                    "Issue ISS-{} refers to milestone {milestone}, which is not in the file.",
                    issue.number
                )),
                Some(Some(project)) if issue.project_id.as_deref() != Some(project) => problems
                    .push(format!(
                        "Issue ISS-{}'s milestone belongs to another project.",
                        issue.number
                    )),
                _ => {}
            }
        }
    }

    for link in &data.issue_labels {
        if !issues.contains_key(link.issue_id.as_str()) || !labels.contains(link.label_id.as_str())
        {
            problems.push(format!(
                "A label link between {} and {} refers to a record that is not in the file.",
                link.issue_id, link.label_id
            ));
        }
    }
    for link in &data.objective_issues {
        match (
            objectives.get(link.objective_id.as_str()),
            issues.get(link.issue_id.as_str()),
        ) {
            (Some(project), Some(issue_project)) if Some(*project) == *issue_project => {}
            (Some(_), Some(_)) => problems.push(format!(
                "Objective {} links issue {} from another project.",
                link.objective_id, link.issue_id
            )),
            _ => problems.push(format!(
                "An objective link between {} and {} refers to a record that is not in the file.",
                link.objective_id, link.issue_id
            )),
        }
    }

    let mut parents: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut blocks: HashMap<&str, Vec<&str>> = HashMap::new();
    for relation in &data.relationships {
        let (source, target) = (relation.source_id.as_str(), relation.target_id.as_str());
        if !issues.contains_key(source) || !issues.contains_key(target) {
            problems.push(format!(
                "A relationship between {source} and {target} refers to an issue that is not in the file."
            ));
            continue;
        }
        if source == target {
            problems.push(format!("Issue {source} is related to itself."));
            continue;
        }
        match relation.kind.as_str() {
            "parent" => {
                let entry = parents.entry(source).or_default();
                entry.push(target);
                if entry.len() == 2 {
                    problems.push(format!("Issue {source} has more than one parent."));
                }
            }
            "blocks" => blocks.entry(source).or_default().push(target),
            "related" => {}
            other => problems.push(format!("Unknown relationship kind \"{other}\".")),
        }
    }
    if has_cycle(&parents) {
        problems.push("Parent relationships form a cycle.".into());
    }
    if has_cycle(&blocks) {
        problems.push("Blocking relationships form a cycle.".into());
    }
    problems
}

/// Parses and validates file content, rejecting it before any write.
pub fn parse(content: &str) -> Result<ProjectData, PortError> {
    if content.len() > MAX_IMPORT_BYTES {
        return Err(PortError::TooLarge);
    }
    let data: ProjectData =
        serde_json::from_str(content).map_err(|error| PortError::UnreadableFile {
            detail: error.to_string(),
        })?;
    let problems = validate(&data);
    if !problems.is_empty() {
        let total = problems.len();
        return Err(PortError::InvalidFile {
            problems: problems.into_iter().take(MAX_PROBLEMS).collect(),
            total,
        });
    }
    Ok(data)
}

/// A new UUID for the record with ID `old`, remembered for references.
fn fresh<'a>(ids: &mut HashMap<&'a str, String>, old: &'a str) -> String {
    let id = Uuid::new_v4().to_string();
    ids.insert(old, id.clone());
    id
}

/// Writes the file's records as copies with new IDs and numbers inside the
/// caller's transaction, and reports what happened.
async fn apply<'a>(
    transaction: &mut Transaction<'_, Sqlite>,
    workspace: &str,
    data: &'a ProjectData,
) -> Result<ImportReport, PortError> {
    let mut report = ImportReport::default();
    let mut ids: HashMap<&'a str, String> = HashMap::new();
    macro_rules! run {
        ($query:expr) => {
            $query
                .execute(&mut **transaction)
                .await
                .map_err(storage_failed)?
        };
    }

    // Projects come first, which also takes SQLite's write lock.
    for project in &data.projects {
        let id = fresh(&mut ids, &project.id);
        run!(sqlx::query(
            "INSERT INTO projects
                 (id, workspace_id, name, description, status, start_date, target_date,
                  created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(id)
        .bind(workspace)
        .bind(project.name.trim())
        .bind(
            project
                .description
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
        )
        .bind(&project.status)
        .bind(&project.start_date)
        .bind(&project.target_date)
        .bind(&project.created_at)
        .bind(&project.updated_at));
        report.projects += 1;
    }

    // Labels match existing names; archived ones are archived after linking.
    let mut existing_archived = HashSet::new();
    let mut archive_after = Vec::new();
    for label in &data.labels {
        let key = label.name.trim().to_lowercase();
        let found: Option<(String, bool)> = sqlx::query_as(
            "SELECT id, archived_at IS NOT NULL FROM labels WHERE workspace_id = ? AND name_key = ?",
        )
        .bind(workspace)
        .bind(&key)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(storage_failed)?;
        if let Some((id, archived)) = found {
            if archived {
                existing_archived.insert(id.clone());
            }
            ids.insert(label.id.as_str(), id);
            report.labels_reused.push(label.name.trim().to_owned());
            continue;
        }
        let id = fresh(&mut ids, &label.id);
        run!(sqlx::query(
            "INSERT INTO labels (id, workspace_id, name, name_key, description, color)
             VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(&id)
        .bind(workspace)
        .bind(label.name.trim())
        .bind(key)
        .bind(
            label
                .description
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
        )
        .bind(&label.color));
        if label.archived {
            archive_after.push(id);
        }
        report.labels_created += 1;
    }

    for milestone in &data.milestones {
        let id = fresh(&mut ids, &milestone.id);
        let project = milestone.project_id.as_deref().map(|p| ids[p].clone());
        run!(sqlx::query(&format!(
            "INSERT INTO milestones
                 (id, workspace_id, project_id, title, description, due_date, state, closed_at)
             VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? THEN 'closed' ELSE 'open' END,
                     CASE WHEN ? THEN {NOW} END)"
        ))
        .bind(id)
        .bind(workspace)
        .bind(project)
        .bind(milestone.title.trim())
        .bind(
            milestone
                .description
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
        )
        .bind(&milestone.due_date)
        .bind(milestone.closed)
        .bind(milestone.closed));
        report.milestones += 1;
    }

    for mission in &data.missions {
        let id = fresh(&mut ids, &mission.id);
        run!(sqlx::query(
            "INSERT INTO missions (id, project_id, title, description) VALUES (?, ?, ?, ?)"
        )
        .bind(id)
        .bind(&ids[mission.project_id.as_str()])
        .bind(mission.title.trim())
        .bind(mission.description.trim()));
        report.missions += 1;
    }
    for objective in &data.objectives {
        let id = fresh(&mut ids, &objective.id);
        run!(sqlx::query(
            "INSERT INTO objectives (id, project_id, mission_id, title, description)
             VALUES (?, ?, ?, ?, ?)"
        )
        .bind(id)
        .bind(&ids[objective.project_id.as_str()])
        .bind(objective.mission_id.as_deref().map(|m| ids[m].clone()))
        .bind(objective.title.trim())
        .bind(objective.description.trim()));
        report.objectives += 1;
    }

    // Issues take the workspace's next numbers in their original order.
    let mut issues: Vec<&PortableIssue> = data.issues.iter().collect();
    issues.sort_by_key(|issue| issue.number);
    for issue in issues {
        let id = fresh(&mut ids, &issue.id);
        let number: i64 = sqlx::query_scalar(
            "INSERT INTO issue_counters (workspace_id, last_number) VALUES (?, 1)
             ON CONFLICT (workspace_id) DO UPDATE SET last_number = last_number + 1
             RETURNING last_number",
        )
        .bind(workspace)
        .fetch_one(&mut **transaction)
        .await
        .map_err(storage_failed)?;
        let done = issue.status == "done";
        if done && issue.completed_at.is_none() {
            report.completion_repaired += 1;
        }
        let title = issue.title.trim();
        run!(sqlx::query(&format!(
            "INSERT INTO issues
                 (id, workspace_id, number, project_id, milestone_id, title, description,
                  status, priority, start_date, due_date, completed_at, created_at, updated_at,
                  search_text, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     CASE WHEN ? THEN coalesce(?, {NOW}) END, ?, ?, ?,
                     CASE WHEN ? THEN {NOW} END)"
        ))
        .bind(&id)
        .bind(workspace)
        .bind(number)
        .bind(issue.project_id.as_deref().map(|p| ids[p].clone()))
        .bind(issue.milestone_id.as_deref().map(|m| ids[m].clone()))
        .bind(title)
        .bind(&issue.description)
        .bind(&issue.status)
        .bind(&issue.priority)
        .bind(&issue.start_date)
        .bind(&issue.due_date)
        .bind(done)
        .bind(&issue.completed_at)
        .bind(&issue.created_at)
        .bind(&issue.updated_at)
        .bind(search_text(title, &issue.description))
        .bind(issue.archived));
        report.issues += 1;
        report
            .renumbered
            .push((format!("ISS-{}", issue.number), format!("ISS-{number}")));
    }

    for link in &data.issue_labels {
        let label = &ids[link.label_id.as_str()];
        if existing_archived.contains(label) {
            report.skipped_label_links += 1;
            continue;
        }
        run!(sqlx::query(
            "INSERT INTO issue_labels (issue_id, label_id, workspace_id) VALUES (?, ?, ?)
             ON CONFLICT DO NOTHING"
        )
        .bind(&ids[link.issue_id.as_str()])
        .bind(label)
        .bind(workspace));
    }
    for label in archive_after {
        run!(sqlx::query(&format!(
            "UPDATE labels SET archived_at = {NOW} WHERE id = ?"
        ))
        .bind(label));
    }
    for link in &data.objective_issues {
        run!(sqlx::query(
            "INSERT INTO objective_issues (objective_id, issue_id) VALUES (?, ?)
             ON CONFLICT DO NOTHING"
        )
        .bind(&ids[link.objective_id.as_str()])
        .bind(&ids[link.issue_id.as_str()]));
    }
    for relation in &data.relationships {
        let (mut source, mut target) = (
            ids[relation.source_id.as_str()].clone(),
            ids[relation.target_id.as_str()].clone(),
        );
        // Related links are stored once, in UUID order.
        if relation.kind == "related" && source > target {
            std::mem::swap(&mut source, &mut target);
        }
        run!(sqlx::query(
            "INSERT INTO issue_relationships (workspace_id, source_id, target_id, kind)
             VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING"
        )
        .bind(workspace)
        .bind(source)
        .bind(target)
        .bind(&relation.kind));
        report.relationships += 1;
    }
    Ok(report)
}

/// Validates the file and imports it in one transaction, or with
/// `commit: false` runs every step and rolls back, for a preview.
pub async fn import(
    pool: &SqlitePool,
    workspace: &str,
    content: &str,
    commit: bool,
) -> Result<ImportReport, PortError> {
    let data = parse(content)?;
    let mut transaction = pool.begin().await.map_err(storage_failed)?;
    let report = apply(&mut transaction, workspace, &data).await?;
    if commit {
        transaction.commit().await.map_err(storage_failed)?;
    } else {
        transaction.rollback().await.map_err(storage_failed)?;
    }
    Ok(report)
}

/// One CSV field, quoted per RFC 4180 when needed. Text a spreadsheet could
/// run as a formula is prefixed with an apostrophe.
pub fn csv_field(value: &str) -> String {
    let mut value = value.to_owned();
    if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        value.insert(0, '\'');
    }
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

/// Every issue matching the list query, in its order, as CSV.
pub async fn issues_csv(
    pool: &SqlitePool,
    workspace: &str,
    query: IssueQuery,
) -> Result<(String, usize), PortError> {
    let mut issues: Vec<IssueSummary> = Vec::new();
    loop {
        let page = crate::issues::query(
            pool,
            workspace,
            IssueQuery {
                limit: Some(crate::issues::MAX_QUERY_LIMIT),
                offset: issues.len() as u32,
                ..query.clone()
            },
        )
        .await
        .map_err(|error| match error {
            crate::issues::IssueError::InvalidFilter => PortError::InvalidFilter,
            _ => PortError::StorageFailed,
        })?;
        let done =
            page.issues.is_empty() || issues.len() + page.issues.len() >= page.total as usize;
        issues.extend(page.issues);
        if done {
            break;
        }
    }
    let names = |sql: &str| {
        let sql = sql.to_owned();
        async move {
            sqlx::query_as::<_, (String, String)>(&sql)
                .bind(workspace)
                .fetch_all(pool)
                .await
                .map(|rows| rows.into_iter().collect::<HashMap<_, _>>())
                .map_err(storage_failed)
        }
    };
    let projects = names("SELECT id, name FROM projects WHERE workspace_id = ?").await?;
    let milestones = names("SELECT id, title FROM milestones WHERE workspace_id = ?").await?;
    let labels = names("SELECT id, name FROM labels WHERE workspace_id = ?").await?;
    let mut csv = String::from(
        "Key,Title,Status,Priority,Project,Milestone,Labels,Start date,Due date,\
         Completed at,Created at,Updated at,Archived\r\n",
    );
    for issue in &issues {
        let mut label_names: Vec<&str> = issue
            .label_ids
            .0
            .iter()
            .filter_map(|id| labels.get(id).map(String::as_str))
            .collect();
        label_names.sort_unstable();
        let lookup = |map: &HashMap<String, String>, id: &Option<String>| {
            id.as_ref()
                .and_then(|id| map.get(id))
                .cloned()
                .unwrap_or_default()
        };
        let row = [
            format!("ISS-{}", issue.number),
            issue.title.clone(),
            issue.status.clone(),
            issue.priority.clone(),
            lookup(&projects, &issue.project_id),
            lookup(&milestones, &issue.milestone_id),
            label_names.join("; "),
            issue.start_date.clone().unwrap_or_default(),
            issue.due_date.clone().unwrap_or_default(),
            issue.completed_at.clone().unwrap_or_default(),
            issue.created_at.clone(),
            issue.updated_at.clone(),
            if issue.archived_at.is_some() {
                "yes"
            } else {
                "no"
            }
            .into(),
        ];
        csv.push_str(
            &row.iter()
                .map(|field| csv_field(field))
                .collect::<Vec<_>>()
                .join(","),
        );
        csv.push_str("\r\n");
    }
    Ok((csv, issues.len()))
}

/// Asks where to save with the native dialog, then writes `content`.
/// Returns `None` when the user cancels.
async fn save_with_dialog(
    app: AppHandle,
    name: String,
    filter: (&'static str, &'static str),
    content: String,
) -> Result<Option<String>, PortError> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name(&name)
            .add_filter(filter.0, &[filter.1])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|_| PortError::WriteFailed)?;
        std::fs::write(&path, content).map_err(|error| {
            eprintln!("Could not write {}: {error}", path.display());
            PortError::WriteFailed
        })?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(|_| PortError::WriteFailed)?
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), PortError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn export_project_data(
    app: AppHandle,
    instances: State<'_, DbInstances>,
) -> Result<Option<SavedFile>, PortError> {
    let (pool, workspace) = scope(&instances).await?;
    let data = export(&pool, &workspace).await?;
    let records = data.projects.len() + data.issues.len();
    let name = format!("unhollowed-projects-{}.json", &data.exported_at[..10]);
    let content = serde_json::to_string_pretty(&data).map_err(|_| PortError::WriteFailed)?;
    Ok(save_with_dialog(app, name, ("JSON", "json"), content)
        .await?
        .map(|path| SavedFile { path, records }))
}

#[tauri::command]
pub async fn export_issues_csv(
    app: AppHandle,
    instances: State<'_, DbInstances>,
    query: IssueQuery,
) -> Result<Option<SavedFile>, PortError> {
    let (pool, workspace) = scope(&instances).await?;
    let (content, records) = issues_csv(&pool, &workspace, query).await?;
    Ok(
        save_with_dialog(app, "unhollowed-issues.csv".into(), ("CSV", "csv"), content)
            .await?
            .map(|path| SavedFile { path, records }),
    )
}

#[tauri::command]
pub async fn preview_import(
    instances: State<'_, DbInstances>,
    content: String,
) -> Result<ImportReport, PortError> {
    let (pool, workspace) = scope(&instances).await?;
    import(&pool, &workspace, &content, false).await
}

#[tauri::command]
pub async fn import_project_data(
    instances: State<'_, DbInstances>,
    content: String,
) -> Result<ImportReport, PortError> {
    let (pool, workspace) = scope(&instances).await?;
    import(&pool, &workspace, &content, true).await
}

#[cfg(test)]
mod tests;
