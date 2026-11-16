//! Saved issue views. A view stores a name and a versioned configuration of
//! the shared list filters, which the webview applies like URL filters.

use crate::database::{active_workspace, pool, DatabaseError};
use crate::issues::{PRIORITIES, STATUSES};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

/// The configuration version this build writes and reads.
pub const CONFIG_VERSION: i64 = 1;
const MAX_NAME_CHARS: usize = 80;
const MAX_TEXT_CHARS: usize = 200;
const MAX_IDS: usize = 100;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/// Version 1 of the stored filters. Values are the list's URL filters, so
/// due dates stay relative presets (such as `overdue`) and resolve against
/// the local date whenever the view opens. Empty strings mean "any".
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ViewFilters {
    pub state: String,
    pub text: String,
    pub status: String,
    pub priority: String,
    /// A project ID, `inbox`, or empty.
    pub project: String,
    pub due: String,
    pub labels: Vec<String>,
    pub label_match: String,
    /// A milestone ID, `none`, or empty.
    pub milestone: String,
    pub sort: String,
    pub direction: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewConfig {
    pub version: i64,
    /// `list` or `board`.
    pub view: String,
    pub filters: ViewFilters,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub id: String,
    pub name: String,
    pub config: ViewConfig,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(FromRow)]
struct Row {
    id: String,
    name: String,
    config: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum ViewError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    NotFound,
    InvalidName,
    /// Another view in the workspace has this name.
    DuplicateName,
    /// The configuration is not a supported version or has invalid values.
    InvalidConfig,
    StorageFailed,
}

impl From<DatabaseError> for ViewError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> ViewError {
    if error
        .as_database_error()
        .is_some_and(|error| error.is_unique_violation())
    {
        return ViewError::DuplicateName;
    }
    eprintln!("Saved view storage failed: {error}");
    ViewError::StorageFailed
}

fn one_of(value: &str, allowed: &[&str]) -> bool {
    value.is_empty() || allowed.contains(&value)
}

fn reference(value: &str) -> bool {
    value.len() <= 64 && !value.contains('\0') && !value.contains(',')
}

/// Checks a configuration against version 1 of the shared filters.
fn validate(config: &ViewConfig) -> Result<(), ViewError> {
    let filters = &config.filters;
    let valid = config.version == CONFIG_VERSION
        && matches!(config.view.as_str(), "list" | "board")
        && one_of(&filters.state, &["open", "closed", "all"])
        && filters.text.chars().count() <= MAX_TEXT_CHARS
        && !filters.text.contains('\0')
        && one_of(&filters.status, &STATUSES)
        && one_of(&filters.priority, &PRIORITIES)
        && reference(&filters.project)
        && one_of(&filters.due, &["overdue", "today", "week", "dated", "none"])
        && filters.labels.len() <= MAX_IDS
        && filters
            .labels
            .iter()
            .all(|id| !id.is_empty() && reference(id))
        && one_of(&filters.label_match, &["any", "all"])
        && reference(&filters.milestone)
        && one_of(
            &filters.sort,
            &["updated", "created", "priority", "title", "due"],
        )
        && one_of(&filters.direction, &["asc", "desc"]);
    if valid {
        Ok(())
    } else {
        Err(ViewError::InvalidConfig)
    }
}

fn valid_name(name: &str) -> Result<(String, String), ViewError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name.contains('\0') {
        return Err(ViewError::InvalidName);
    }
    Ok((name.to_owned(), name.to_lowercase()))
}

fn view(row: Row) -> Result<SavedView, ViewError> {
    let config = serde_json::from_str(&row.config).map_err(|error| {
        eprintln!(
            "Saved view {} has an unreadable configuration: {error}",
            row.id
        );
        ViewError::InvalidConfig
    })?;
    Ok(SavedView {
        id: row.id,
        name: row.name,
        config,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

const FIELDS: &str = "id, name, config, created_at, updated_at";

/// The workspace's views by name. A view whose stored configuration cannot
/// be read is left out rather than hiding every other view.
pub async fn list(pool: &SqlitePool, workspace: &str) -> Result<Vec<SavedView>, ViewError> {
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM saved_views WHERE workspace_id = ? ORDER BY name_key, id"
    ))
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;
    Ok(rows.into_iter().filter_map(|row| view(row).ok()).collect())
}

pub async fn get(pool: &SqlitePool, workspace: &str, id: &str) -> Result<SavedView, ViewError> {
    let row: Row = sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM saved_views WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(ViewError::NotFound)?;
    view(row)
}

pub async fn create(
    pool: &SqlitePool,
    workspace: &str,
    name: &str,
    config: ViewConfig,
) -> Result<SavedView, ViewError> {
    let (name, key) = valid_name(name)?;
    validate(&config)?;
    let row: Row = sqlx::query_as(&format!(
        "INSERT INTO saved_views (id, workspace_id, name, name_key, config_version, config)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING {FIELDS}"
    ))
    .bind(Uuid::new_v4().to_string())
    .bind(workspace)
    .bind(name)
    .bind(key)
    .bind(config.version)
    .bind(serde_json::to_string(&config).map_err(|_| ViewError::InvalidConfig)?)
    .fetch_one(pool)
    .await
    .map_err(storage_failed)?;
    view(row)
}

/// Renames a view, replaces its filters, or both.
pub async fn update(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    name: &str,
    config: ViewConfig,
) -> Result<SavedView, ViewError> {
    let (name, key) = valid_name(name)?;
    validate(&config)?;
    let row: Row = sqlx::query_as(&format!(
        "UPDATE saved_views SET name = ?, name_key = ?, config_version = ?, config = ?,
             updated_at = {NOW}
         WHERE id = ? AND workspace_id = ? RETURNING {FIELDS}"
    ))
    .bind(name)
    .bind(key)
    .bind(config.version)
    .bind(serde_json::to_string(&config).map_err(|_| ViewError::InvalidConfig)?)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(ViewError::NotFound)?;
    view(row)
}

/// Removes a view. Views only store filters, so no issue data is affected.
pub async fn remove(pool: &SqlitePool, workspace: &str, id: &str) -> Result<(), ViewError> {
    let removed = sqlx::query("DELETE FROM saved_views WHERE id = ? AND workspace_id = ?")
        .bind(id)
        .bind(workspace)
        .execute(pool)
        .await
        .map_err(storage_failed)?
        .rows_affected();
    if removed == 0 {
        return Err(ViewError::NotFound);
    }
    Ok(())
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), ViewError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn list_saved_views(
    instances: State<'_, DbInstances>,
) -> Result<Vec<SavedView>, ViewError> {
    let (pool, workspace) = scope(&instances).await?;
    list(&pool, &workspace).await
}

#[tauri::command]
pub async fn get_saved_view(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<SavedView, ViewError> {
    let (pool, workspace) = scope(&instances).await?;
    get(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn create_saved_view(
    instances: State<'_, DbInstances>,
    name: String,
    config: ViewConfig,
) -> Result<SavedView, ViewError> {
    let (pool, workspace) = scope(&instances).await?;
    create(&pool, &workspace, &name, config).await
}

#[tauri::command]
pub async fn update_saved_view(
    instances: State<'_, DbInstances>,
    id: String,
    name: String,
    config: ViewConfig,
) -> Result<SavedView, ViewError> {
    let (pool, workspace) = scope(&instances).await?;
    update(&pool, &workspace, &id, &name, config).await
}

#[tauri::command]
pub async fn delete_saved_view(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<(), ViewError> {
    let (pool, workspace) = scope(&instances).await?;
    remove(&pool, &workspace, &id).await
}

#[cfg(test)]
mod tests;
