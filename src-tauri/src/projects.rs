use crate::database::{active_workspace, pool, DatabaseError};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    id: String,
    name: String,
    description: Option<String>,
    status: String,
    start_date: Option<String>,
    target_date: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    name: String,
    description: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum ProjectError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    NotFound,
    InvalidName,
    InvalidDescription,
    InvalidDate,
    InvalidDateRange,
    InvalidStatus,
    StorageFailed,
}

impl From<DatabaseError> for ProjectError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> ProjectError {
    eprintln!("Project storage failed: {error}");
    ProjectError::StorageFailed
}

fn valid_date(value: &str) -> bool {
    let parts: Vec<_> = value.split('-').collect();
    let [year, month, day] = parts.as_slice() else {
        return false;
    };
    if year.len() != 4
        || month.len() != 2
        || day.len() != 2
        || !parts
            .iter()
            .all(|part| part.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    let year: u16 = year.parse().unwrap();
    let month: u8 = month.parse().unwrap();
    let day: u8 = day.parse().unwrap();
    let days = match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    year > 0 && (1..=days).contains(&day)
}

impl ProjectInput {
    fn validate(mut self) -> Result<Self, ProjectError> {
        self.name = self.name.trim().to_owned();
        if self.name.is_empty() || self.name.chars().count() > 200 || self.name.contains('\0') {
            return Err(ProjectError::InvalidName);
        }
        self.description = self
            .description
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if self
            .description
            .as_ref()
            .is_some_and(|value| value.chars().count() > 5000 || value.contains('\0'))
        {
            return Err(ProjectError::InvalidDescription);
        }
        if self
            .start_date
            .iter()
            .chain(&self.target_date)
            .any(|date| !valid_date(date))
        {
            return Err(ProjectError::InvalidDate);
        }
        if let (Some(start), Some(target)) = (&self.start_date, &self.target_date) {
            if start > target {
                return Err(ProjectError::InvalidDateRange);
            }
        }
        Ok(self)
    }
}

const FIELDS: &str =
    "id, name, description, status, start_date, target_date, created_at, updated_at";
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

async fn list(pool: &SqlitePool, workspace: &str) -> Result<Vec<Project>, ProjectError> {
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC, id"
    ))
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)
}

async fn get(pool: &SqlitePool, workspace: &str, id: &str) -> Result<Project, ProjectError> {
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM projects WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(ProjectError::NotFound)
}

async fn create(
    pool: &SqlitePool,
    workspace: &str,
    input: ProjectInput,
) -> Result<Project, ProjectError> {
    let input = input.validate()?;
    sqlx::query_as(&format!(
        "INSERT INTO projects (id, workspace_id, name, description, start_date, target_date)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING {FIELDS}"
    ))
    .bind(Uuid::new_v4().to_string())
    .bind(workspace)
    .bind(input.name)
    .bind(input.description)
    .bind(input.start_date)
    .bind(input.target_date)
    .fetch_one(pool)
    .await
    .map_err(storage_failed)
}

async fn update(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    input: ProjectInput,
) -> Result<Project, ProjectError> {
    let input = input.validate()?;
    sqlx::query_as(&format!(
        "UPDATE projects SET name = ?, description = ?, start_date = ?, target_date = ?, updated_at = {NOW}
         WHERE id = ? AND workspace_id = ? RETURNING {FIELDS}"
    ))
    .bind(input.name)
    .bind(input.description)
    .bind(input.start_date)
    .bind(input.target_date)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(ProjectError::NotFound)
}

async fn set_status(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    status: &str,
) -> Result<Project, ProjectError> {
    if !matches!(
        status,
        "planned" | "active" | "on_hold" | "completed" | "archived"
    ) {
        return Err(ProjectError::InvalidStatus);
    }
    sqlx::query_as(&format!(
        "UPDATE projects SET status = ?, updated_at = CASE WHEN status = ? THEN updated_at ELSE {NOW} END
         WHERE id = ? AND workspace_id = ? RETURNING {FIELDS}"
    ))
    .bind(status)
    .bind(status)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(ProjectError::NotFound)
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), ProjectError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn list_projects(
    instances: State<'_, DbInstances>,
) -> Result<Vec<Project>, ProjectError> {
    let (pool, workspace) = scope(&instances).await?;
    list(&pool, &workspace).await
}

#[tauri::command]
pub async fn get_project(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Project, ProjectError> {
    let (pool, workspace) = scope(&instances).await?;
    get(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn create_project(
    instances: State<'_, DbInstances>,
    input: ProjectInput,
) -> Result<Project, ProjectError> {
    let (pool, workspace) = scope(&instances).await?;
    create(&pool, &workspace, input).await
}

#[tauri::command]
pub async fn update_project(
    instances: State<'_, DbInstances>,
    id: String,
    input: ProjectInput,
) -> Result<Project, ProjectError> {
    let (pool, workspace) = scope(&instances).await?;
    update(&pool, &workspace, &id, input).await
}

#[tauri::command]
pub async fn change_project_status(
    instances: State<'_, DbInstances>,
    id: String,
    status: String,
) -> Result<Project, ProjectError> {
    let (pool, workspace) = scope(&instances).await?;
    set_status(&pool, &workspace, &id, &status).await
}

#[tauri::command]
pub async fn archive_project(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Project, ProjectError> {
    let (pool, workspace) = scope(&instances).await?;
    set_status(&pool, &workspace, &id, "archived").await
}

#[cfg(test)]
mod tests;
