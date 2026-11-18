//! Dashboard layouts. A dashboard stores a name and a versioned layout (the
//! period it shows and its widget instances). It never stores analytics
//! values: widgets read their numbers from the authoritative queries.
//!
//! Storage is SQLite, not browser storage, because layouts are per workspace,
//! must update atomically, and must survive a profile reset. Rust validates
//! every write; reads return the stored layout untouched so the webview can
//! recover from layouts it does not understand without losing them.

use crate::database::{active_workspace, pool, DatabaseError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, SqlitePool};
use std::collections::HashSet;
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

/// The layout version this build writes and reads.
pub const LAYOUT_VERSION: i64 = 1;
const MAX_NAME_CHARS: usize = 80;
const MAX_WIDGETS: usize = 60;
const MAX_CONFIG_BYTES: usize = 8 * 1024;
const MAX_DASHBOARDS: i64 = 20;
const GRID_COLUMNS: i64 = 12;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Custom {
    from: String,
    to: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preferences {
    preset: String,
    custom: Custom,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Widget {
    id: String,
    /// Any well-formed type: types this build does not know are kept.
    #[serde(rename = "type")]
    kind: String,
    version: i64,
    #[serde(default)]
    config: Value,
    hidden: bool,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Layout {
    version: i64,
    preferences: Preferences,
    widgets: Vec<Widget>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub layout_version: i64,
    /// The stored layout as written. A newer version is returned as is.
    pub layout: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(FromRow)]
struct Row {
    id: String,
    name: String,
    position: i64,
    layout_version: i64,
    layout: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum DashboardError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    NotFound,
    InvalidName,
    DuplicateName,
    InvalidLayout,
    /// The stored layout was written by a newer release and is left alone.
    NewerLayout,
    /// The workspace already has the most dashboards it can hold.
    TooMany,
    StorageFailed,
}

impl From<DatabaseError> for DashboardError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> DashboardError {
    if error
        .as_database_error()
        .is_some_and(|error| error.is_unique_violation())
    {
        return DashboardError::DuplicateName;
    }
    eprintln!("Dashboard storage failed: {error}");
    DashboardError::StorageFailed
}

fn valid_day(text: &str) -> bool {
    text.len() == 10 && text >= "1900-01-01" && text.parse::<jiff::civil::Date>().is_ok()
}

fn token(text: &str, max: usize) -> bool {
    !text.is_empty()
        && text.len() <= max
        && text.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Checks a layout against version 1 and returns it in canonical form.
fn validate(raw: Value) -> Result<String, DashboardError> {
    let layout: Layout = serde_json::from_value(raw).map_err(|_| DashboardError::InvalidLayout)?;
    let mut seen = HashSet::new();
    let widgets_ok = layout.widgets.len() <= MAX_WIDGETS
        && layout.widgets.iter().all(|widget| {
            token(&widget.id, 64)
                && seen.insert(widget.id.as_str())
                && token(&widget.kind, 64)
                && (1..=1000).contains(&widget.version)
                && (widget.config.is_null() || widget.config.is_object())
                && serde_json::to_string(&widget.config).is_ok_and(|c| c.len() <= MAX_CONFIG_BYTES)
                && (0..GRID_COLUMNS).contains(&widget.x)
                && (1..=GRID_COLUMNS).contains(&widget.w)
                && widget.x + widget.w <= GRID_COLUMNS
                && (0..=999).contains(&widget.y)
                && (1..=40).contains(&widget.h)
        });
    let preferences = &layout.preferences;
    let valid = layout.version == LAYOUT_VERSION
        && widgets_ok
        && matches!(
            preferences.preset.as_str(),
            "last7" | "last30" | "month" | "custom"
        )
        && valid_day(&preferences.custom.from)
        && valid_day(&preferences.custom.to);
    if !valid {
        return Err(DashboardError::InvalidLayout);
    }
    serde_json::to_string(&layout).map_err(|_| DashboardError::InvalidLayout)
}

fn valid_name(name: &str) -> Result<(String, String), DashboardError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name.contains('\0') {
        return Err(DashboardError::InvalidName);
    }
    Ok((name.to_owned(), name.to_lowercase()))
}

fn dashboard(row: Row) -> Result<Dashboard, DashboardError> {
    let layout = serde_json::from_str(&row.layout).map_err(|error| {
        eprintln!("Dashboard {} has unreadable JSON: {error}", row.id);
        DashboardError::StorageFailed
    })?;
    Ok(Dashboard {
        id: row.id,
        name: row.name,
        position: row.position,
        layout_version: row.layout_version,
        layout,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

const FIELDS: &str = "id, name, position, layout_version, layout, created_at, updated_at";

/// The workspace's dashboards in display order.
pub async fn list(pool: &SqlitePool, workspace: &str) -> Result<Vec<Dashboard>, DashboardError> {
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM dashboards WHERE workspace_id = ? ORDER BY position, name_key, id"
    ))
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;
    rows.into_iter().map(dashboard).collect()
}

/// Creates a dashboard (`id` is `None`) or replaces one's name and layout in
/// a single statement. A layout from a newer release is never overwritten.
pub async fn save(
    pool: &SqlitePool,
    workspace: &str,
    id: Option<&str>,
    name: &str,
    layout: Value,
) -> Result<Dashboard, DashboardError> {
    let (name, key) = valid_name(name)?;
    let layout = validate(layout)?;
    let row: Row = match id {
        None => {
            let (count,): (i64,) =
                sqlx::query_as("SELECT count(*) FROM dashboards WHERE workspace_id = ?")
                    .bind(workspace)
                    .fetch_one(pool)
                    .await
                    .map_err(storage_failed)?;
            if count >= MAX_DASHBOARDS {
                return Err(DashboardError::TooMany);
            }
            sqlx::query_as(&format!(
                "INSERT INTO dashboards
                     (id, workspace_id, name, name_key, position, layout_version, layout)
                 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING {FIELDS}"
            ))
            .bind(Uuid::new_v4().to_string())
            .bind(workspace)
            .bind(name)
            .bind(key)
            .bind(count)
            .bind(LAYOUT_VERSION)
            .bind(layout)
            .fetch_one(pool)
            .await
            .map_err(storage_failed)?
        }
        Some(id) => {
            let updated: Option<Row> = sqlx::query_as(&format!(
                "UPDATE dashboards SET name = ?, name_key = ?, layout_version = ?, layout = ?,
                     updated_at = {NOW}
                 WHERE id = ? AND workspace_id = ? AND layout_version <= ? RETURNING {FIELDS}"
            ))
            .bind(name)
            .bind(key)
            .bind(LAYOUT_VERSION)
            .bind(layout)
            .bind(id)
            .bind(workspace)
            .bind(LAYOUT_VERSION)
            .fetch_optional(pool)
            .await
            .map_err(storage_failed)?;
            match updated {
                Some(row) => row,
                None => {
                    let exists: Option<(i64,)> = sqlx::query_as(
                        "SELECT 1 FROM dashboards WHERE id = ? AND workspace_id = ?",
                    )
                    .bind(id)
                    .bind(workspace)
                    .fetch_optional(pool)
                    .await
                    .map_err(storage_failed)?;
                    return Err(if exists.is_some() {
                        DashboardError::NewerLayout
                    } else {
                        DashboardError::NotFound
                    });
                }
            }
        }
    };
    dashboard(row)
}

/// Removes a dashboard. Only its layout is deleted; no workspace data is.
pub async fn remove(pool: &SqlitePool, workspace: &str, id: &str) -> Result<(), DashboardError> {
    let removed = sqlx::query("DELETE FROM dashboards WHERE id = ? AND workspace_id = ?")
        .bind(id)
        .bind(workspace)
        .execute(pool)
        .await
        .map_err(storage_failed)?
        .rows_affected();
    if removed == 0 {
        return Err(DashboardError::NotFound);
    }
    Ok(())
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), DashboardError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn list_dashboards(
    instances: State<'_, DbInstances>,
) -> Result<Vec<Dashboard>, DashboardError> {
    let (pool, workspace) = scope(&instances).await?;
    list(&pool, &workspace).await
}

#[tauri::command]
pub async fn save_dashboard(
    instances: State<'_, DbInstances>,
    id: Option<String>,
    name: String,
    layout: Value,
) -> Result<Dashboard, DashboardError> {
    let (pool, workspace) = scope(&instances).await?;
    save(&pool, &workspace, id.as_deref(), &name, layout).await
}

#[tauri::command]
pub async fn delete_dashboard(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<(), DashboardError> {
    let (pool, workspace) = scope(&instances).await?;
    remove(&pool, &workspace, &id).await
}

#[cfg(test)]
mod tests;
