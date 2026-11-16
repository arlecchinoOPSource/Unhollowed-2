use crate::database::{active_workspace, pool, DatabaseError};
use crate::projects::valid_date;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

const MAX_TITLE_CHARS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 5000;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/// A milestone with issue counts derived from its issues when read.
///
/// Progress counts completed (done) issues against open plus completed ones.
/// Canceled issues are counted separately and do not affect progress.
#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    pub id: String,
    /// `None` for a workspace milestone.
    pub project_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub due_date: Option<String>,
    pub closed: bool,
    pub closed_at: Option<String>,
    pub open_count: i64,
    pub completed_count: i64,
    pub canceled_count: i64,
    /// Open issues that are blocked, a subset of `open_count`.
    pub blocked_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Editable fields. The project is chosen at creation and cannot change.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneInput {
    pub title: String,
    pub description: Option<String>,
    pub due_date: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum MilestoneError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    NotFound,
    InvalidTitle,
    InvalidDescription,
    InvalidDate,
    /// The project does not exist in the active workspace.
    InvalidProject,
    StorageFailed,
}

impl From<DatabaseError> for MilestoneError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> MilestoneError {
    eprintln!("Milestone storage failed: {error}");
    MilestoneError::StorageFailed
}

impl MilestoneInput {
    fn validate(self) -> Result<Self, MilestoneError> {
        let title = self.title.trim().to_owned();
        if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS || title.contains('\0') {
            return Err(MilestoneError::InvalidTitle);
        }
        let description = self
            .description
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if description.as_ref().is_some_and(|value| {
            value.chars().count() > MAX_DESCRIPTION_CHARS || value.contains('\0')
        }) {
            return Err(MilestoneError::InvalidDescription);
        }
        if self
            .due_date
            .as_deref()
            .is_some_and(|date| !valid_date(date))
        {
            return Err(MilestoneError::InvalidDate);
        }
        Ok(Self {
            title,
            description,
            due_date: self.due_date,
        })
    }
}

const FIELDS: &str = "id, project_id, title, description, due_date, state = 'closed' AS closed, \
     closed_at, created_at, updated_at, \
     (SELECT count(*) FROM issues WHERE milestone_id = milestones.id AND closed = 0) AS open_count, \
     (SELECT count(*) FROM issues WHERE milestone_id = milestones.id AND status = 'done') \
         AS completed_count, \
     (SELECT count(*) FROM issues WHERE milestone_id = milestones.id AND status = 'canceled') \
         AS canceled_count, \
     (SELECT count(*) FROM issues WHERE milestone_id = milestones.id AND status = 'blocked') \
         AS blocked_count";

/// Open milestones first, then by due date with undated last, then title.
pub async fn list(pool: &SqlitePool, workspace: &str) -> Result<Vec<Milestone>, MilestoneError> {
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM milestones WHERE workspace_id = ?
         ORDER BY state = 'closed', due_date IS NULL, due_date, title COLLATE NOCASE, id"
    ))
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)
}

pub async fn get(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
) -> Result<Milestone, MilestoneError> {
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM milestones WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(MilestoneError::NotFound)
}

/// Creates a workspace milestone, or a project milestone when `project` is set.
pub async fn create(
    pool: &SqlitePool,
    workspace: &str,
    input: MilestoneInput,
    project: Option<&str>,
) -> Result<Milestone, MilestoneError> {
    let input = input.validate()?;
    if let Some(project) = project {
        sqlx::query("SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?")
            .bind(project)
            .bind(workspace)
            .fetch_optional(pool)
            .await
            .map_err(storage_failed)?
            .ok_or(MilestoneError::InvalidProject)?;
    }
    sqlx::query_as(&format!(
        "INSERT INTO milestones (id, workspace_id, project_id, title, description, due_date)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING {FIELDS}"
    ))
    .bind(Uuid::new_v4().to_string())
    .bind(workspace)
    .bind(project)
    .bind(input.title)
    .bind(input.description)
    .bind(input.due_date)
    .fetch_one(pool)
    .await
    .map_err(storage_failed)
}

pub async fn update(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    input: MilestoneInput,
) -> Result<Milestone, MilestoneError> {
    let input = input.validate()?;
    sqlx::query_as(&format!(
        "UPDATE milestones SET title = ?, description = ?, due_date = ?, updated_at = {NOW}
         WHERE id = ? AND workspace_id = ? RETURNING {FIELDS}"
    ))
    .bind(input.title)
    .bind(input.description)
    .bind(input.due_date)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(MilestoneError::NotFound)
}

/// Closes or reopens a milestone. Repeating the current state changes
/// nothing. Its issues keep their links either way.
pub async fn set_closed(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    closed: bool,
) -> Result<Milestone, MilestoneError> {
    sqlx::query_as(&format!(
        "UPDATE milestones SET
             state = CASE WHEN ?1 THEN 'closed' ELSE 'open' END,
             closed_at = CASE WHEN ?1 THEN coalesce(closed_at, {NOW}) END,
             updated_at = CASE WHEN (state = 'closed') = ?1 THEN updated_at ELSE {NOW} END
         WHERE id = ?2 AND workspace_id = ?3 RETURNING {FIELDS}"
    ))
    .bind(closed)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(MilestoneError::NotFound)
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), MilestoneError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn list_milestones(
    instances: State<'_, DbInstances>,
) -> Result<Vec<Milestone>, MilestoneError> {
    let (pool, workspace) = scope(&instances).await?;
    list(&pool, &workspace).await
}

#[tauri::command]
pub async fn get_milestone(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Milestone, MilestoneError> {
    let (pool, workspace) = scope(&instances).await?;
    get(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn create_milestone(
    instances: State<'_, DbInstances>,
    input: MilestoneInput,
    project_id: Option<String>,
) -> Result<Milestone, MilestoneError> {
    let (pool, workspace) = scope(&instances).await?;
    create(&pool, &workspace, input, project_id.as_deref()).await
}

#[tauri::command]
pub async fn update_milestone(
    instances: State<'_, DbInstances>,
    id: String,
    input: MilestoneInput,
) -> Result<Milestone, MilestoneError> {
    let (pool, workspace) = scope(&instances).await?;
    update(&pool, &workspace, &id, input).await
}

#[tauri::command]
pub async fn close_milestone(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Milestone, MilestoneError> {
    let (pool, workspace) = scope(&instances).await?;
    set_closed(&pool, &workspace, &id, true).await
}

#[tauri::command]
pub async fn reopen_milestone(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Milestone, MilestoneError> {
    let (pool, workspace) = scope(&instances).await?;
    set_closed(&pool, &workspace, &id, false).await
}

#[cfg(test)]
mod tests;
