//! Calendar management: create, edit, show or hide, choose the default,
//! archive and restore, and move events between calendars.
//!
//! Rules, from docs/CALENDAR.md:
//! - A workspace always has exactly one default, and it is active.
//! - Archiving keeps every event. Archiving the default requires an active
//!   replacement, which becomes the default in the same transaction.
//! - Names are unique among a workspace's calendars, ignoring case.
//! - Moving an event changes only its calendar, so it keeps its ID.

use super::{
    ensure_default, get_event_on, scope, writable_calendar, Calendar, Event, SchedulingError,
    CALENDAR_FIELDS,
};
use serde::Deserialize;
use sqlx::{SqliteConnection, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarInput {
    pub name: String,
    pub description: Option<String>,
    pub color: String,
}

impl CalendarInput {
    fn validate(mut self) -> Result<Self, SchedulingError> {
        self.name = self.name.trim().to_owned();
        if self.name.is_empty() || self.name.chars().count() > 80 || self.name.contains('\0') {
            return Err(SchedulingError::InvalidName);
        }
        self.description = self
            .description
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if self
            .description
            .as_ref()
            .is_some_and(|value| value.chars().count() > 500 || value.contains('\0'))
        {
            return Err(SchedulingError::InvalidDescription);
        }
        if !crate::labels::COLORS.contains(&self.color.as_str()) {
            return Err(SchedulingError::InvalidColor);
        }
        Ok(self)
    }
}

async fn get_on(
    conn: &mut SqliteConnection,
    workspace: &str,
    id: &str,
) -> Result<Calendar, SchedulingError> {
    sqlx::query_as(&format!(
        "SELECT {CALENDAR_FIELDS} FROM calendars WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(conn)
    .await?
    .ok_or(SchedulingError::CalendarNotFound)
}

async fn check_name(
    conn: &mut SqliteConnection,
    workspace: &str,
    name: &str,
    except: Option<&str>,
) -> Result<(), SchedulingError> {
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (
             SELECT 1 FROM calendars
             WHERE workspace_id = ? AND lower(name) = lower(?) AND id IS NOT ?
         )",
    )
    .bind(workspace)
    .bind(name)
    .bind(except)
    .fetch_one(conn)
    .await?;
    if taken {
        return Err(SchedulingError::DuplicateName);
    }
    Ok(())
}

pub async fn create(
    pool: &SqlitePool,
    workspace: &str,
    input: CalendarInput,
) -> Result<Calendar, SchedulingError> {
    let input = input.validate()?;
    let mut tx = pool.begin().await?;
    // Create the default first, so a new workspace's first calendar is
    // never the default by accident.
    ensure_default(&mut tx, workspace).await?;
    check_name(&mut tx, workspace, &input.name, None).await?;
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO calendars (id, workspace_id, name, description, color) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(workspace)
    .bind(&input.name)
    .bind(&input.description)
    .bind(&input.color)
    .execute(&mut *tx)
    .await?;
    let calendar = get_on(&mut tx, workspace, &id).await?;
    tx.commit().await?;
    Ok(calendar)
}

/// Renames, recolors, or redescribes a calendar. Archived calendars can be
/// edited too.
pub async fn update(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    input: CalendarInput,
) -> Result<Calendar, SchedulingError> {
    let input = input.validate()?;
    let mut tx = pool.begin().await?;
    get_on(&mut tx, workspace, id).await?;
    check_name(&mut tx, workspace, &input.name, Some(id)).await?;
    sqlx::query(&format!(
        "UPDATE calendars SET name = ?, description = ?, color = ?, updated_at = {NOW}
         WHERE id = ? AND workspace_id = ?"
    ))
    .bind(&input.name)
    .bind(&input.description)
    .bind(&input.color)
    .bind(id)
    .bind(workspace)
    .execute(&mut *tx)
    .await?;
    let calendar = get_on(&mut tx, workspace, id).await?;
    tx.commit().await?;
    Ok(calendar)
}

/// Shows or hides a calendar's events in calendar views. The setting is
/// stored with the calendar, so it survives restarts.
pub async fn set_hidden(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    hidden: bool,
) -> Result<Calendar, SchedulingError> {
    let mut tx = pool.begin().await?;
    get_on(&mut tx, workspace, id).await?;
    sqlx::query(&format!(
        "UPDATE calendars SET hidden = ?, updated_at = CASE WHEN hidden = ? THEN updated_at ELSE {NOW} END
         WHERE id = ? AND workspace_id = ?"
    ))
    .bind(hidden)
    .bind(hidden)
    .bind(id)
    .bind(workspace)
    .execute(&mut *tx)
    .await?;
    let calendar = get_on(&mut tx, workspace, id).await?;
    tx.commit().await?;
    Ok(calendar)
}

/// Clears the old default and sets the new one in one transaction, so the
/// partial unique index never sees two.
async fn make_default(
    conn: &mut SqliteConnection,
    workspace: &str,
    id: &str,
) -> Result<(), SchedulingError> {
    sqlx::query(&format!(
        "UPDATE calendars SET is_default = 0, updated_at = {NOW}
         WHERE workspace_id = ? AND is_default = 1 AND id <> ?"
    ))
    .bind(workspace)
    .bind(id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(&format!(
        "UPDATE calendars SET is_default = 1, updated_at = CASE WHEN is_default = 1 THEN updated_at ELSE {NOW} END
         WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn set_default(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
) -> Result<Calendar, SchedulingError> {
    let mut tx = pool.begin().await?;
    if get_on(&mut tx, workspace, id).await?.archived_at.is_some() {
        return Err(SchedulingError::CalendarArchived);
    }
    make_default(&mut tx, workspace, id).await?;
    let calendar = get_on(&mut tx, workspace, id).await?;
    tx.commit().await?;
    Ok(calendar)
}

/// Archives a calendar and keeps its events. Archiving the default needs an
/// active `replacement`, which becomes the default first.
pub async fn archive(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    replacement: Option<&str>,
) -> Result<Calendar, SchedulingError> {
    let mut tx = pool.begin().await?;
    let calendar = get_on(&mut tx, workspace, id).await?;
    if calendar.archived_at.is_some() {
        tx.commit().await?;
        return Ok(calendar);
    }
    if calendar.is_default {
        let replacement = replacement
            .filter(|other| *other != id)
            .ok_or(SchedulingError::ReplacementRequired)?;
        match get_on(&mut tx, workspace, replacement).await {
            Ok(other) if other.archived_at.is_none() => {}
            _ => return Err(SchedulingError::ReplacementRequired),
        }
        make_default(&mut tx, workspace, replacement).await?;
    }
    sqlx::query(&format!(
        "UPDATE calendars SET archived_at = {NOW}, updated_at = {NOW} WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .execute(&mut *tx)
    .await?;
    let calendar = get_on(&mut tx, workspace, id).await?;
    tx.commit().await?;
    Ok(calendar)
}

pub async fn restore(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
) -> Result<Calendar, SchedulingError> {
    let mut tx = pool.begin().await?;
    get_on(&mut tx, workspace, id).await?;
    sqlx::query(&format!(
        "UPDATE calendars SET archived_at = NULL, updated_at = CASE WHEN archived_at IS NULL THEN updated_at ELSE {NOW} END
         WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .execute(&mut *tx)
    .await?;
    let calendar = get_on(&mut tx, workspace, id).await?;
    tx.commit().await?;
    Ok(calendar)
}

/// Moves an event to another active calendar in the same workspace. Only
/// its calendar changes, so its ID and every other field stay the same.
pub async fn move_event(
    pool: &SqlitePool,
    workspace: &str,
    event_id: &str,
    calendar_id: &str,
) -> Result<Event, SchedulingError> {
    let mut tx = pool.begin().await?;
    let event = get_event_on(&mut tx, workspace, event_id).await?;
    if event.calendar_id == calendar_id {
        tx.commit().await?;
        return Ok(event);
    }
    writable_calendar(&mut tx, workspace, calendar_id).await?;
    sqlx::query(&format!(
        "UPDATE events SET calendar_id = ?, updated_at = {NOW} WHERE id = ? AND workspace_id = ?"
    ))
    .bind(calendar_id)
    .bind(event_id)
    .bind(workspace)
    .execute(&mut *tx)
    .await?;
    let event = get_event_on(&mut tx, workspace, event_id).await?;
    tx.commit().await?;
    Ok(event)
}

#[tauri::command]
pub async fn create_calendar(
    instances: State<'_, DbInstances>,
    input: CalendarInput,
) -> Result<Calendar, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    create(&pool, &workspace, input).await
}

#[tauri::command]
pub async fn update_calendar(
    instances: State<'_, DbInstances>,
    id: String,
    input: CalendarInput,
) -> Result<Calendar, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    update(&pool, &workspace, &id, input).await
}

#[tauri::command]
pub async fn set_calendar_hidden(
    instances: State<'_, DbInstances>,
    id: String,
    hidden: bool,
) -> Result<Calendar, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    set_hidden(&pool, &workspace, &id, hidden).await
}

#[tauri::command]
pub async fn set_default_calendar(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Calendar, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    set_default(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn archive_calendar(
    instances: State<'_, DbInstances>,
    id: String,
    replacement: Option<String>,
) -> Result<Calendar, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    archive(&pool, &workspace, &id, replacement.as_deref()).await
}

#[tauri::command]
pub async fn restore_calendar(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Calendar, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    restore(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn move_calendar_event(
    instances: State<'_, DbInstances>,
    id: String,
    calendar_id: String,
) -> Result<Event, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    move_event(&pool, &workspace, &id, &calendar_id).await
}

#[cfg(test)]
mod tests;
