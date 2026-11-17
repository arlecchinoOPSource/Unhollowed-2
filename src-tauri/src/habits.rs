//! Habits and their daily completions. docs/HABITS.md is the contract.
//!
//! Every function takes the workspace, and the ones that depend on the date
//! take `today`, so tests can fix both. The Tauri commands resolve them in
//! Rust: the active workspace from `app_state`, today from the device clock.

use crate::database::{active_workspace, pool, DatabaseError};
use serde::Serialize;
use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

const MAX_NAME_CHARS: usize = 60;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const FIELDS: &str = "id, name, position, start_date, archived_on, source, source_id, \
     revision, created_at, updated_at";

#[derive(Clone, Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Habit {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub start_date: String,
    /// The last eligible day, inclusive. `None` while the habit is active.
    pub archived_on: Option<String>,
    pub source: Option<String>,
    pub source_id: Option<String>,
    /// Raised by every write to the habit or its completions.
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum HabitError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    NotFound,
    InvalidName,
    InvalidDate,
    InvalidMonth,
    /// An active habit in the workspace already has this name.
    DuplicateName,
    /// The order is not exactly the workspace's habits, each once.
    InvalidOrder,
    FutureDate,
    BeforeStart,
    /// The day is after the habit's archive day.
    Inactive,
    /// Only archived habits can be deleted.
    NotArchived,
    /// The habit or its history changed after the deletion was reviewed.
    Changed,
    StorageFailed,
}

impl From<DatabaseError> for HabitError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> HabitError {
    if let Some(database) = error.as_database_error() {
        if database.is_unique_violation() && database.message().contains("name_key") {
            return HabitError::DuplicateName;
        }
    }
    eprintln!("Habit storage failed: {error}");
    HabitError::StorageFailed
}

fn valid_name(name: &str) -> Result<(String, String), HabitError> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(HabitError::InvalidName);
    }
    Ok((name.to_owned(), name.to_lowercase()))
}

/// A real calendar day written exactly as `YYYY-MM-DD`.
fn valid_date(date: &str) -> Result<jiff::civil::Date, HabitError> {
    date.parse::<jiff::civil::Date>()
        .ok()
        .filter(|parsed| date.len() == 10 && parsed.to_string() == date)
        .ok_or(HabitError::InvalidDate)
}

/// Today on the device clock, as `YYYY-MM-DD`.
fn local_today() -> String {
    jiff::Zoned::now().date().to_string()
}

pub async fn get(pool: &SqlitePool, workspace: &str, id: &str) -> Result<Habit, HabitError> {
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM habits WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(HabitError::NotFound)
}

/// Every habit in the saved order, archived included.
pub async fn list(pool: &SqlitePool, workspace: &str) -> Result<Vec<Habit>, HabitError> {
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM habits WHERE workspace_id = ? ORDER BY position"
    ))
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)
}

/// Adds a habit at the end of the order. It starts today unless a start is given.
pub async fn create(
    pool: &SqlitePool,
    workspace: &str,
    name: &str,
    start_date: Option<&str>,
    today: &str,
) -> Result<Habit, HabitError> {
    let (name, name_key) = valid_name(name)?;
    let start = start_date.unwrap_or(today);
    valid_date(start)?;
    sqlx::query_as(&format!(
        "INSERT INTO habits (id, workspace_id, name, name_key, position, start_date)
         VALUES (?1, ?2, ?3, ?4,
             (SELECT coalesce(max(position), -1) + 1 FROM habits WHERE workspace_id = ?2), ?5)
         RETURNING {FIELDS}"
    ))
    .bind(Uuid::new_v4().to_string())
    .bind(workspace)
    .bind(name)
    .bind(name_key)
    .bind(start)
    .fetch_one(pool)
    .await
    .map_err(storage_failed)
}

/// Renames a habit. Its ID, order, dates, and completions stay the same.
pub async fn rename(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    name: &str,
) -> Result<Habit, HabitError> {
    let (name, name_key) = valid_name(name)?;
    sqlx::query_as(&format!(
        "UPDATE habits SET name = ?, name_key = ?, revision = revision + 1, updated_at = {NOW}
         WHERE id = ? AND workspace_id = ? RETURNING {FIELDS}"
    ))
    .bind(name)
    .bind(name_key)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(HabitError::NotFound)
}

/// Saves a new order. `ids` must hold every habit in the workspace exactly
/// once, archived included. Either the whole order is saved or none of it.
pub async fn reorder(
    pool: &SqlitePool,
    workspace: &str,
    ids: &[String],
) -> Result<Vec<Habit>, HabitError> {
    // Positions are parked this far above their final values between the
    // single-row updates, so the unique index never sees two equal positions.
    const PARKED: i64 = i32::MAX as i64;
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(storage_failed)?;
    let mut current: Vec<String> =
        sqlx::query_scalar("SELECT id FROM habits WHERE workspace_id = ?")
            .bind(workspace)
            .fetch_all(&mut *tx)
            .await
            .map_err(storage_failed)?;
    let mut wanted = ids.to_vec();
    current.sort();
    wanted.sort();
    if current != wanted {
        return Err(HabitError::InvalidOrder);
    }
    sqlx::query("UPDATE habits SET position = position + ? WHERE workspace_id = ?")
        .bind(PARKED)
        .bind(workspace)
        .execute(&mut *tx)
        .await
        .map_err(storage_failed)?;
    for (position, id) in ids.iter().enumerate() {
        sqlx::query(&format!(
            "UPDATE habits SET
                 revision = revision + (position - ?1 <> ?2),
                 updated_at = CASE WHEN position - ?1 = ?2 THEN updated_at ELSE {NOW} END,
                 position = ?2
             WHERE id = ?3 AND workspace_id = ?4"
        ))
        .bind(PARKED)
        .bind(position as i64)
        .bind(id)
        .bind(workspace)
        .execute(&mut *tx)
        .await
        .map_err(storage_failed)?;
    }
    tx.commit().await.map_err(storage_failed)?;
    list(pool, workspace).await
}

/// Archives a habit as of today, its last eligible day, or its start date if
/// that is later. Completions are kept. Archiving an archived habit changes nothing.
pub async fn archive(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    today: &str,
) -> Result<Habit, HabitError> {
    valid_date(today)?;
    sqlx::query(&format!(
        "UPDATE habits SET archived_on = max(?1, start_date), revision = revision + 1,
             updated_at = {NOW}
         WHERE id = ?2 AND workspace_id = ?3 AND archived_on IS NULL"
    ))
    .bind(today)
    .bind(id)
    .bind(workspace)
    .execute(pool)
    .await
    .map_err(storage_failed)?;
    get(pool, workspace, id).await
}

/// Makes an archived habit active again. The days it spent archived become
/// eligible; no completion is added or removed. Restoring an active habit
/// changes nothing.
pub async fn restore(pool: &SqlitePool, workspace: &str, id: &str) -> Result<Habit, HabitError> {
    sqlx::query(&format!(
        "UPDATE habits SET archived_on = NULL, revision = revision + 1, updated_at = {NOW}
         WHERE id = ? AND workspace_id = ? AND archived_on IS NOT NULL"
    ))
    .bind(id)
    .bind(workspace)
    .execute(pool)
    .await
    .map_err(storage_failed)?;
    get(pool, workspace, id).await
}

/// What deleting a habit would remove. `revision` must be passed back to
/// [`delete`], which refuses if anything changed in between.
#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionImpact {
    pub name: String,
    pub archived: bool,
    pub completions: i64,
    pub first_date: Option<String>,
    pub last_date: Option<String>,
    pub revision: i64,
}

async fn impact_on(
    tx: &mut Transaction<'_, Sqlite>,
    workspace: &str,
    id: &str,
) -> Result<DeletionImpact, HabitError> {
    sqlx::query_as(
        "SELECT h.name, h.archived_on IS NOT NULL AS archived, count(c.date) AS completions,
             min(c.date) AS first_date, max(c.date) AS last_date, h.revision
         FROM habits AS h LEFT JOIN habit_completions AS c ON c.habit_id = h.id
         WHERE h.id = ? AND h.workspace_id = ?
         GROUP BY h.id",
    )
    .bind(id)
    .bind(workspace)
    .fetch_optional(&mut **tx)
    .await
    .map_err(storage_failed)?
    .ok_or(HabitError::NotFound)
}

pub async fn deletion_impact(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
) -> Result<DeletionImpact, HabitError> {
    let mut tx = pool.begin().await.map_err(storage_failed)?;
    impact_on(&mut tx, workspace, id).await
}

/// Permanently deletes an archived habit and its completions, only if it is
/// still at the `revision` the user reviewed.
pub async fn delete(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    revision: i64,
) -> Result<(), HabitError> {
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(storage_failed)?;
    let impact = impact_on(&mut tx, workspace, id).await?;
    if !impact.archived {
        return Err(HabitError::NotArchived);
    }
    if impact.revision != revision {
        return Err(HabitError::Changed);
    }
    sqlx::query("DELETE FROM habits WHERE id = ? AND workspace_id = ?")
        .bind(id)
        .bind(workspace)
        .execute(&mut *tx)
        .await
        .map_err(storage_failed)?;
    tx.commit().await.map_err(storage_failed)
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub habit_id: String,
    pub date: String,
}

/// One month of the grid, read in one transaction so habits and completions agree.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitMonth {
    pub today: String,
    /// Habits eligible on at least one day of the month, in the saved order.
    pub habits: Vec<Habit>,
    pub completions: Vec<Completion>,
}

pub async fn month(
    pool: &SqlitePool,
    workspace: &str,
    year: i16,
    month: i8,
    today: &str,
) -> Result<HabitMonth, HabitError> {
    let first = jiff::civil::Date::new(year, month, 1)
        .ok()
        .filter(|first| first.year() >= 1)
        .ok_or(HabitError::InvalidMonth)?;
    let (first, last) = (first.to_string(), first.last_of_month().to_string());
    let mut tx = pool.begin().await.map_err(storage_failed)?;
    let habits: Vec<Habit> = sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM habits
         WHERE workspace_id = ?1 AND start_date <= ?3
             AND (archived_on IS NULL OR archived_on >= ?2)
         ORDER BY position"
    ))
    .bind(workspace)
    .bind(&first)
    .bind(&last)
    .fetch_all(&mut *tx)
    .await
    .map_err(storage_failed)?;
    let completions = sqlx::query_as::<_, (String, String)>(
        "SELECT habit_id, date FROM habit_completions
         WHERE workspace_id = ? AND date BETWEEN ? AND ? ORDER BY date, habit_id",
    )
    .bind(workspace)
    .bind(&first)
    .bind(&last)
    .fetch_all(&mut *tx)
    .await
    .map_err(storage_failed)?
    .into_iter()
    .map(|(habit_id, date)| Completion { habit_id, date })
    .collect();
    Ok(HabitMonth {
        today: today.to_owned(),
        habits,
        completions,
    })
}

/// Every completed day of one habit, oldest first.
pub async fn history(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
) -> Result<Vec<String>, HabitError> {
    get(pool, workspace, id).await?;
    sqlx::query_scalar(
        "SELECT date FROM habit_completions WHERE habit_id = ? AND workspace_id = ? ORDER BY date",
    )
    .bind(id)
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)
}

/// Marks one habit-day done or not done and returns the saved state. Saving
/// the state a day already has changes nothing, so a repeated request is safe.
pub async fn set_completion(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    date: &str,
    done: bool,
    today: &str,
) -> Result<bool, HabitError> {
    valid_date(date)?;
    valid_date(today)?;
    if date > today {
        return Err(HabitError::FutureDate);
    }
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(storage_failed)?;
    let (start, archived_on): (String, Option<String>) = sqlx::query_as(
        "SELECT start_date, archived_on FROM habits WHERE id = ? AND workspace_id = ?",
    )
    .bind(id)
    .bind(workspace)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage_failed)?
    .ok_or(HabitError::NotFound)?;
    if date < start.as_str() {
        return Err(HabitError::BeforeStart);
    }
    if archived_on.is_some_and(|last| date > last.as_str()) {
        return Err(HabitError::Inactive);
    }
    let sql = if done {
        "INSERT INTO habit_completions (habit_id, workspace_id, date) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING"
    } else {
        "DELETE FROM habit_completions WHERE habit_id = ? AND workspace_id = ? AND date = ?"
    };
    let changed = sqlx::query(sql)
        .bind(id)
        .bind(workspace)
        .bind(date)
        .execute(&mut *tx)
        .await
        .map_err(storage_failed)?
        .rows_affected();
    if changed > 0 {
        sqlx::query(&format!(
            "UPDATE habits SET revision = revision + 1, updated_at = {NOW} WHERE id = ?"
        ))
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(storage_failed)?;
    }
    tx.commit().await.map_err(storage_failed)?;
    Ok(done)
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), HabitError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn list_habits(instances: State<'_, DbInstances>) -> Result<Vec<Habit>, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    list(&pool, &workspace).await
}

#[tauri::command]
pub async fn create_habit(
    instances: State<'_, DbInstances>,
    name: String,
    start_date: Option<String>,
) -> Result<Habit, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    create(
        &pool,
        &workspace,
        &name,
        start_date.as_deref(),
        &local_today(),
    )
    .await
}

#[tauri::command]
pub async fn rename_habit(
    instances: State<'_, DbInstances>,
    id: String,
    name: String,
) -> Result<Habit, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    rename(&pool, &workspace, &id, &name).await
}

#[tauri::command]
pub async fn reorder_habits(
    instances: State<'_, DbInstances>,
    ids: Vec<String>,
) -> Result<Vec<Habit>, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    reorder(&pool, &workspace, &ids).await
}

#[tauri::command]
pub async fn archive_habit(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Habit, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    archive(&pool, &workspace, &id, &local_today()).await
}

#[tauri::command]
pub async fn restore_habit(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Habit, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    restore(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn get_habit_deletion_impact(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<DeletionImpact, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    deletion_impact(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn delete_habit(
    instances: State<'_, DbInstances>,
    id: String,
    revision: i64,
) -> Result<(), HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    delete(&pool, &workspace, &id, revision).await
}

#[tauri::command]
pub async fn get_habit_month(
    instances: State<'_, DbInstances>,
    year: i16,
    month: i8,
) -> Result<HabitMonth, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    self::month(&pool, &workspace, year, month, &local_today()).await
}

#[tauri::command]
pub async fn list_habit_history(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Vec<String>, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    history(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn set_habit_completion(
    instances: State<'_, DbInstances>,
    id: String,
    date: String,
    done: bool,
) -> Result<bool, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    set_completion(&pool, &workspace, &id, &date, done, &local_today()).await
}

#[cfg(test)]
mod schema_tests;
#[cfg(test)]
mod tests;
