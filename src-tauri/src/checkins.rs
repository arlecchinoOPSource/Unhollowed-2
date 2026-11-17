//! Private daily check-ins: optional mood, energy, and focus ratings from 1 to
//! 5 and a note, one record per workspace and local day. docs/DATA_MODEL.md
//! ("Daily check-ins") is the contract.
//!
//! Saving replaces the whole record for the day, so a rating the user clears
//! becomes unset. A rating is never inferred or defaulted. A save with no
//! rating and no note deletes the day's record instead of storing an empty
//! one. Every function takes the workspace and, for the date rules, today, so
//! tests can fix both.

use crate::database::{active_workspace, pool, DatabaseError};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

const MAX_NOTE_CHARS: usize = 2000;
/// The longest range `list` returns, about ten years.
const MAX_RANGE_DAYS: i64 = 3_660;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const FIELDS: &str = "id, date, mood, energy, focus, note, created_at, updated_at";

#[derive(Clone, Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkin {
    pub id: String,
    pub date: String,
    pub mood: Option<i64>,
    pub energy: Option<i64>,
    pub focus: Option<i64>,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum CheckinError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    InvalidDate,
    /// Check-ins cannot be written for days that have not happened.
    FutureDate,
    /// A rating that is not a whole number from 1 to 5.
    InvalidRating,
    /// The note is longer than 2000 characters.
    NoteTooLong,
    /// A range that ends before it starts or is over about ten years.
    InvalidRange,
    StorageFailed,
}

impl From<DatabaseError> for CheckinError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

impl From<crate::habits::HabitError> for CheckinError {
    fn from(error: crate::habits::HabitError) -> Self {
        use crate::habits::HabitError;
        match error {
            HabitError::DatabaseUnavailable => Self::DatabaseUnavailable,
            HabitError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
            HabitError::InvalidDate => Self::InvalidDate,
            HabitError::InvalidRange => Self::InvalidRange,
            _ => Self::StorageFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> CheckinError {
    eprintln!("Check-in storage failed: {error}");
    CheckinError::StorageFailed
}

/// A real calendar day written exactly as `YYYY-MM-DD`.
fn valid_date(date: &str) -> Result<jiff::civil::Date, CheckinError> {
    date.parse::<jiff::civil::Date>()
        .ok()
        .filter(|parsed| date.len() == 10 && parsed.to_string() == date && parsed.year() >= 1900)
        .ok_or(CheckinError::InvalidDate)
}

fn valid_rating(rating: Option<i64>) -> Result<Option<i64>, CheckinError> {
    match rating {
        Some(value) if !(1..=5).contains(&value) => Err(CheckinError::InvalidRating),
        other => Ok(other),
    }
}

pub(crate) fn local_today() -> String {
    jiff::Zoned::now().date().to_string()
}

/// The check-in for one day, if the user made one.
pub async fn get(
    pool: &SqlitePool,
    workspace: &str,
    date: &str,
) -> Result<Option<Checkin>, CheckinError> {
    valid_date(date)?;
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM daily_checkins WHERE workspace_id = ? AND date = ?"
    ))
    .bind(workspace)
    .bind(date)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)
}

/// Check-ins from `from` through `to`, oldest first. Days without one are absent.
pub async fn list(
    pool: &SqlitePool,
    workspace: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Checkin>, CheckinError> {
    let (first, last) = (valid_date(from)?, valid_date(to)?);
    let days = first
        .until(last)
        .map_or(i64::MAX, |span| span.get_days() as i64);
    if first > last || days >= MAX_RANGE_DAYS {
        return Err(CheckinError::InvalidRange);
    }
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM daily_checkins
         WHERE workspace_id = ? AND date BETWEEN ? AND ? ORDER BY date"
    ))
    .bind(workspace)
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)
}

/// Saves the day's check-in, replacing what was there, in one statement.
/// Returns `None` when there is nothing to keep: no rating and a blank note
/// delete the day's record. Past days can be edited; future days cannot.
#[allow(clippy::too_many_arguments)]
pub async fn save(
    pool: &SqlitePool,
    workspace: &str,
    date: &str,
    mood: Option<i64>,
    energy: Option<i64>,
    focus: Option<i64>,
    note: Option<&str>,
    today: &str,
) -> Result<Option<Checkin>, CheckinError> {
    let day = valid_date(date)?;
    if day > valid_date(today)? {
        return Err(CheckinError::FutureDate);
    }
    let (mood, energy, focus) = (
        valid_rating(mood)?,
        valid_rating(energy)?,
        valid_rating(focus)?,
    );
    let note = note.map(str::trim).filter(|text| !text.is_empty());
    if note.is_some_and(|text| text.chars().count() > MAX_NOTE_CHARS) {
        return Err(CheckinError::NoteTooLong);
    }
    if mood.is_none() && energy.is_none() && focus.is_none() && note.is_none() {
        delete(pool, workspace, date).await?;
        return Ok(None);
    }
    sqlx::query_as(&format!(
        "INSERT INTO daily_checkins (id, workspace_id, date, mood, energy, focus, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, date) DO UPDATE SET
             mood = excluded.mood, energy = excluded.energy, focus = excluded.focus,
             note = excluded.note, updated_at = {NOW}
         RETURNING {FIELDS}"
    ))
    .bind(Uuid::new_v4().to_string())
    .bind(workspace)
    .bind(date)
    .bind(mood)
    .bind(energy)
    .bind(focus)
    .bind(note)
    .fetch_one(pool)
    .await
    .map(Some)
    .map_err(storage_failed)
}

/// Removes the day's check-in. Removing a day that has none changes nothing.
pub async fn delete(pool: &SqlitePool, workspace: &str, date: &str) -> Result<(), CheckinError> {
    valid_date(date)?;
    sqlx::query("DELETE FROM daily_checkins WHERE workspace_id = ? AND date = ?")
        .bind(workspace)
        .bind(date)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(storage_failed)
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), CheckinError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn get_checkin(
    instances: State<'_, DbInstances>,
    date: String,
) -> Result<Option<Checkin>, CheckinError> {
    let (pool, workspace) = scope(&instances).await?;
    get(&pool, &workspace, &date).await
}

#[tauri::command]
pub async fn list_checkins(
    instances: State<'_, DbInstances>,
    from: String,
    to: String,
) -> Result<Vec<Checkin>, CheckinError> {
    let (pool, workspace) = scope(&instances).await?;
    list(&pool, &workspace, &from, &to).await
}

#[tauri::command]
pub async fn save_checkin(
    instances: State<'_, DbInstances>,
    date: String,
    mood: Option<i64>,
    energy: Option<i64>,
    focus: Option<i64>,
    note: Option<String>,
) -> Result<Option<Checkin>, CheckinError> {
    let (pool, workspace) = scope(&instances).await?;
    save(
        &pool,
        &workspace,
        &date,
        mood,
        energy,
        focus,
        note.as_deref(),
        &local_today(),
    )
    .await
}

#[tauri::command]
pub async fn delete_checkin(
    instances: State<'_, DbInstances>,
    date: String,
) -> Result<(), CheckinError> {
    let (pool, workspace) = scope(&instances).await?;
    delete(&pool, &workspace, &date).await
}

pub mod analytics;
#[cfg(test)]
mod analytics_tests;
#[cfg(test)]
mod tests;
