use crate::database::{active_workspace, pool, DatabaseError};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

pub const COLORS: [&str; 9] = [
    "gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink",
];
const MAX_NAME_CHARS: usize = 50;
const MAX_DESCRIPTION_CHARS: usize = 500;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub archived: bool,
    pub archived_at: Option<String>,
    /// How many issues currently carry the label, including closed ones.
    pub issue_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelInput {
    pub name: String,
    pub description: Option<String>,
    pub color: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum LabelError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    NotFound,
    InvalidName,
    InvalidDescription,
    InvalidColor,
    /// Another label in the workspace, possibly archived, has this name.
    DuplicateName,
    StorageFailed,
}

impl From<DatabaseError> for LabelError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> LabelError {
    if error
        .as_database_error()
        .is_some_and(|error| error.is_unique_violation())
    {
        return LabelError::DuplicateName;
    }
    eprintln!("Label storage failed: {error}");
    LabelError::StorageFailed
}

struct ValidLabel {
    name: String,
    name_key: String,
    description: Option<String>,
    color: String,
}

impl LabelInput {
    fn validate(self) -> Result<ValidLabel, LabelError> {
        let name = self.name.trim().to_owned();
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name.contains('\0') {
            return Err(LabelError::InvalidName);
        }
        let description = self
            .description
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if description.as_ref().is_some_and(|value| {
            value.chars().count() > MAX_DESCRIPTION_CHARS || value.contains('\0')
        }) {
            return Err(LabelError::InvalidDescription);
        }
        if !COLORS.contains(&self.color.as_str()) {
            return Err(LabelError::InvalidColor);
        }
        Ok(ValidLabel {
            name_key: name.to_lowercase(),
            name,
            description,
            color: self.color,
        })
    }
}

const FIELDS: &str = "id, name, description, color, archived_at IS NOT NULL AS archived, \
     archived_at, (SELECT count(*) FROM issue_labels WHERE label_id = labels.id) AS issue_count, \
     created_at, updated_at";

/// Active labels first, then archived ones, each by name.
pub async fn list(pool: &SqlitePool, workspace: &str) -> Result<Vec<Label>, LabelError> {
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM labels WHERE workspace_id = ?
         ORDER BY archived_at IS NOT NULL, name_key, id"
    ))
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)
}

#[cfg(test)]
pub async fn get(pool: &SqlitePool, workspace: &str, id: &str) -> Result<Label, LabelError> {
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM labels WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(LabelError::NotFound)
}

pub async fn create(
    pool: &SqlitePool,
    workspace: &str,
    input: LabelInput,
) -> Result<Label, LabelError> {
    let label = input.validate()?;
    sqlx::query_as(&format!(
        "INSERT INTO labels (id, workspace_id, name, name_key, description, color)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING {FIELDS}"
    ))
    .bind(Uuid::new_v4().to_string())
    .bind(workspace)
    .bind(label.name)
    .bind(label.name_key)
    .bind(label.description)
    .bind(label.color)
    .fetch_one(pool)
    .await
    .map_err(storage_failed)
}

/// Renames, recolors, or redescribes a label. Archived labels can be edited.
pub async fn update(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    input: LabelInput,
) -> Result<Label, LabelError> {
    let label = input.validate()?;
    sqlx::query_as(&format!(
        "UPDATE labels SET name = ?, name_key = ?, description = ?, color = ?, updated_at = {NOW}
         WHERE id = ? AND workspace_id = ? RETURNING {FIELDS}"
    ))
    .bind(label.name)
    .bind(label.name_key)
    .bind(label.description)
    .bind(label.color)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(LabelError::NotFound)
}

/// Archives or restores a label. Repeating the current state changes nothing.
/// Archiving keeps every existing issue link.
pub async fn set_archived(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    archived: bool,
) -> Result<Label, LabelError> {
    sqlx::query_as(&format!(
        "UPDATE labels SET
             archived_at = CASE WHEN ?1 THEN coalesce(archived_at, {NOW}) END,
             updated_at = CASE WHEN (archived_at IS NOT NULL) = ?1 THEN updated_at ELSE {NOW} END
         WHERE id = ?2 AND workspace_id = ?3 RETURNING {FIELDS}"
    ))
    .bind(archived)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(LabelError::NotFound)
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), LabelError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn list_labels(instances: State<'_, DbInstances>) -> Result<Vec<Label>, LabelError> {
    let (pool, workspace) = scope(&instances).await?;
    list(&pool, &workspace).await
}

#[tauri::command]
pub async fn create_label(
    instances: State<'_, DbInstances>,
    input: LabelInput,
) -> Result<Label, LabelError> {
    let (pool, workspace) = scope(&instances).await?;
    create(&pool, &workspace, input).await
}

#[tauri::command]
pub async fn update_label(
    instances: State<'_, DbInstances>,
    id: String,
    input: LabelInput,
) -> Result<Label, LabelError> {
    let (pool, workspace) = scope(&instances).await?;
    update(&pool, &workspace, &id, input).await
}

#[tauri::command]
pub async fn archive_label(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Label, LabelError> {
    let (pool, workspace) = scope(&instances).await?;
    set_archived(&pool, &workspace, &id, true).await
}

#[tauri::command]
pub async fn restore_label(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Label, LabelError> {
    let (pool, workspace) = scope(&instances).await?;
    set_archived(&pool, &workspace, &id, false).await
}

#[cfg(test)]
mod tests;
