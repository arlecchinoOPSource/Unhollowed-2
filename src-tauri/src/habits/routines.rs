//! Habit routines: links from a habit to the recurring calendar events it
//! happens with. docs/HABITS.md, "Routines", is the contract.
//!
//! A link holds only the two IDs. The calendar's own recurrence and agenda
//! queries stay the only schedule; nothing here expands occurrences. Linking
//! never writes a completion, and neither does an occurrence: completion is
//! only ever set through the habit commands.

use super::{get, scope, storage_failed, HabitError};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;

/// A recurring event, as a habit sees it.
#[derive(Clone, Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub event_id: String,
    pub title: String,
    /// `daily`, `weekly`, `monthly`, or `yearly`.
    pub repeat_freq: String,
    pub repeat_interval: i64,
    /// The first day of the series, `YYYY-MM-DD`, for opening it in the calendar.
    pub start_date: String,
}

/// An active habit that happens with an event.
#[derive(Clone, Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineHabit {
    pub event_id: String,
    pub habit_id: String,
    pub name: String,
}

const ROUTINE_FIELDS: &str = "e.id AS event_id, e.title, e.repeat_freq, e.repeat_interval, \
     coalesce(e.start_date, substr(e.start_local, 1, 10)) AS start_date";

/// The recurring events a habit is linked to, by title.
pub async fn for_habit(
    pool: &SqlitePool,
    workspace: &str,
    habit: &str,
) -> Result<Vec<Routine>, HabitError> {
    get(pool, workspace, habit).await?;
    sqlx::query_as(&format!(
        "SELECT {ROUTINE_FIELDS} FROM habit_events AS l
         JOIN events AS e ON e.id = l.event_id AND e.workspace_id = l.workspace_id
         WHERE l.habit_id = ? AND l.workspace_id = ?
           AND e.repeat_freq IS NOT NULL
         ORDER BY e.title COLLATE NOCASE, e.id"
    ))
    .bind(habit)
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)
}

/// Every recurring event in the workspace, for choosing one to link.
pub async fn choices(pool: &SqlitePool, workspace: &str) -> Result<Vec<Routine>, HabitError> {
    sqlx::query_as(&format!(
        "SELECT {ROUTINE_FIELDS} FROM events AS e
         WHERE e.workspace_id = ? AND e.repeat_freq IS NOT NULL
         ORDER BY e.title COLLATE NOCASE, e.id"
    ))
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)
}

/// Links a habit to a recurring event. Linking twice changes nothing. A habit
/// or event in another workspace is not found, and a one-time event is refused.
pub async fn link(
    pool: &SqlitePool,
    workspace: &str,
    habit: &str,
    event: &str,
) -> Result<Vec<Routine>, HabitError> {
    get(pool, workspace, habit).await?;
    let repeats: Option<bool> = sqlx::query_scalar(
        "SELECT repeat_freq IS NOT NULL FROM events WHERE id = ? AND workspace_id = ?",
    )
    .bind(event)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?;
    match repeats {
        None => return Err(HabitError::NotFound),
        Some(false) => return Err(HabitError::NotRecurring),
        Some(true) => {}
    }
    sqlx::query(
        "INSERT OR IGNORE INTO habit_events (habit_id, event_id, workspace_id) VALUES (?, ?, ?)",
    )
    .bind(habit)
    .bind(event)
    .bind(workspace)
    .execute(pool)
    .await
    .map_err(storage_failed)?;
    for_habit(pool, workspace, habit).await
}

/// Removes the link only. Unlinking a link that does not exist changes nothing.
pub async fn unlink(
    pool: &SqlitePool,
    workspace: &str,
    habit: &str,
    event: &str,
) -> Result<Vec<Routine>, HabitError> {
    get(pool, workspace, habit).await?;
    sqlx::query(
        "DELETE FROM habit_events WHERE habit_id = ? AND event_id = ? AND workspace_id = ?",
    )
    .bind(habit)
    .bind(event)
    .bind(workspace)
    .execute(pool)
    .await
    .map_err(storage_failed)?;
    for_habit(pool, workspace, habit).await
}

/// The active habits linked to any of `events`, for the daily agenda. An
/// archived habit keeps its link but is not shown as routine context.
pub async fn for_events(
    pool: &SqlitePool,
    workspace: &str,
    events: &[String],
) -> Result<Vec<RoutineHabit>, HabitError> {
    let mut found = Vec::new();
    for event in events {
        let mut rows: Vec<RoutineHabit> = sqlx::query_as(
            "SELECT l.event_id, h.id AS habit_id, h.name FROM habit_events AS l
             JOIN habits AS h ON h.id = l.habit_id AND h.workspace_id = l.workspace_id
             WHERE l.event_id = ? AND l.workspace_id = ? AND h.archived_on IS NULL
             ORDER BY h.position",
        )
        .bind(event)
        .bind(workspace)
        .fetch_all(pool)
        .await
        .map_err(storage_failed)?;
        found.append(&mut rows);
    }
    Ok(found)
}

#[tauri::command]
pub async fn list_habit_routines(
    instances: State<'_, DbInstances>,
    habit_id: String,
) -> Result<Vec<Routine>, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    for_habit(&pool, &workspace, &habit_id).await
}

#[tauri::command]
pub async fn list_routine_choices(
    instances: State<'_, DbInstances>,
) -> Result<Vec<Routine>, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    choices(&pool, &workspace).await
}

#[tauri::command]
pub async fn link_habit_routine(
    instances: State<'_, DbInstances>,
    habit_id: String,
    event_id: String,
) -> Result<Vec<Routine>, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    link(&pool, &workspace, &habit_id, &event_id).await
}

#[tauri::command]
pub async fn unlink_habit_routine(
    instances: State<'_, DbInstances>,
    habit_id: String,
    event_id: String,
) -> Result<Vec<Routine>, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    unlink(&pool, &workspace, &habit_id, &event_id).await
}

#[tauri::command]
pub async fn list_routine_habits(
    instances: State<'_, DbInstances>,
    event_ids: Vec<String>,
) -> Result<Vec<RoutineHabit>, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    for_events(&pool, &workspace, &event_ids).await
}
