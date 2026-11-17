//! Editing, duplicating, and deleting events. Creation lives with the data
//! model in `scheduling.rs`, and both use the same validation.

use super::{
    bind_timing, clean_text, event_timing, get_event_on, scope, writable_calendar, Event,
    EventInput, SchedulingError,
};
use sqlx::SqlitePool;
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/// Replaces an event's fields. Without `calendarId` the event stays in its
/// calendar. A new calendar must be active and in the same workspace. The
/// write is one transaction, so a failure leaves the saved event unchanged.
pub async fn update(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    mut input: EventInput,
) -> Result<Event, SchedulingError> {
    clean_text(&mut input)?;
    let timing = event_timing(&input)?;
    let rule = super::recurrence::validate(&input.repeat, &timing)?;
    let mut tx = pool.begin().await?;
    let current = get_event_on(&mut tx, workspace, id).await?;
    let calendar = match input.calendar_id.take() {
        Some(calendar) if calendar != current.calendar_id => {
            writable_calendar(&mut tx, workspace, &calendar).await?;
            calendar
        }
        _ => current.calendar_id,
    };
    let sql = format!(
        "UPDATE events SET calendar_id = ?, title = ?, description = ?, location = ?, url = ?,
             all_day = ?, start_date = ?, end_date = ?, time_zone = ?, start_local = ?,
             end_local = ?, start_at = ?, end_at = ?, repeat_freq = ?, repeat_interval = ?,
             repeat_count = ?, repeat_until = ?, updated_at = {NOW}
         WHERE id = ? AND workspace_id = ?"
    );
    let query = sqlx::query(&sql)
        .bind(calendar)
        .bind(&input.title)
        .bind(&input.description)
        .bind(&input.location)
        .bind(&input.url);
    let (freq, interval, count, until) = super::recurrence::rule_columns(&rule);
    bind_timing(query, &timing)
        .bind(freq)
        .bind(interval)
        .bind(count)
        .bind(until)
        .bind(id)
        .bind(workspace)
        .execute(&mut *tx)
        .await?;
    let event = get_event_on(&mut tx, workspace, id).await?;
    // Changes to occurrences the edited series no longer has are removed.
    super::recurrence::prune(&mut tx, &event).await?;
    tx.commit().await?;
    Ok(event)
}

/// Copies an event, with a new ID, into the same calendar at the same time.
/// A recurring event is copied with its rule and occurrence changes.
pub async fn duplicate(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
) -> Result<Event, SchedulingError> {
    let mut tx = pool.begin().await?;
    let event = get_event_on(&mut tx, workspace, id).await?;
    writable_calendar(&mut tx, workspace, &event.calendar_id).await?;
    let copy = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO events (id, workspace_id, calendar_id, title, description, location, url,
             all_day, start_date, end_date, time_zone, start_local, end_local, start_at, end_at,
             repeat_freq, repeat_interval, repeat_count, repeat_until)
         SELECT ?, workspace_id, calendar_id, title, description, location, url,
             all_day, start_date, end_date, time_zone, start_local, end_local, start_at, end_at,
             repeat_freq, repeat_interval, repeat_count, repeat_until
         FROM events WHERE id = ? AND workspace_id = ?",
    )
    .bind(&copy)
    .bind(id)
    .bind(workspace)
    .execute(&mut *tx)
    .await?;
    // A copied series keeps its occurrences' changes.
    sqlx::query(
        "INSERT INTO event_exceptions (event_id, occurrence, canceled, title, description, location, url,
             start_date, end_date, start_local, end_local, start_at, end_at)
         SELECT ?, occurrence, canceled, title, description, location, url,
             start_date, end_date, start_local, end_local, start_at, end_at
         FROM event_exceptions WHERE event_id = ?",
    )
    .bind(&copy)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let event = get_event_on(&mut tx, workspace, &copy).await?;
    tx.commit().await?;
    Ok(event)
}

/// Permanently deletes an event. The editor asks for confirmation first.
pub async fn delete(pool: &SqlitePool, workspace: &str, id: &str) -> Result<(), SchedulingError> {
    let deleted = sqlx::query("DELETE FROM events WHERE id = ? AND workspace_id = ?")
        .bind(id)
        .bind(workspace)
        .execute(pool)
        .await?
        .rows_affected();
    if deleted == 0 {
        return Err(SchedulingError::NotFound);
    }
    Ok(())
}

#[tauri::command]
pub async fn update_calendar_event(
    instances: State<'_, DbInstances>,
    id: String,
    input: EventInput,
) -> Result<Event, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    update(&pool, &workspace, &id, input).await
}

#[tauri::command]
pub async fn duplicate_calendar_event(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Event, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    duplicate(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn delete_calendar_event(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<(), SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    delete(&pool, &workspace, &id).await
}

#[cfg(test)]
mod tests;
