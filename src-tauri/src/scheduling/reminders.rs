//! Local reminders for timed events.
//!
//! The webview asks `claim_due_reminders` every half minute and on resume.
//! Rust decides what is due from the stored events, so edits, cancellations,
//! and deletions take effect at once. A reminder is due from its time until
//! the event starts, and each delivery is recorded under the event,
//! occurrence, start, and offset so it is claimed once, even across restarts.
//! A reminder missed because the app was closed or asleep past the event's
//! start is dropped. The app must be running to deliver: no background
//! mechanism is used. Notifications are sent from Rust through the
//! notification plugin, so the webview needs no notification permission.

use super::{list_items, scope, time, CalendarItem, ItemKind, ItemRange, SchedulingError};
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_sql::DbInstances;

/// The longest reminder offset, one week in minutes.
pub const MAX_MINUTES: i64 = 10_080;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueReminder {
    pub event_id: String,
    pub title: String,
    /// The start of the occurrence being reminded, as a UTC instant.
    pub start_at: String,
    pub minutes_before: i64,
}

async fn event_exists(
    pool: &SqlitePool,
    workspace: &str,
    event: &str,
) -> Result<bool, SchedulingError> {
    Ok(
        sqlx::query("SELECT 1 FROM events WHERE id = ? AND workspace_id = ?")
            .bind(event)
            .bind(workspace)
            .fetch_optional(pool)
            .await?
            .is_some(),
    )
}

pub async fn enabled(pool: &SqlitePool, workspace: &str) -> Result<bool, SchedulingError> {
    let stored: Option<i64> =
        sqlx::query_scalar("SELECT enabled FROM reminder_settings WHERE workspace_id = ?")
            .bind(workspace)
            .fetch_optional(pool)
            .await?;
    Ok(stored != Some(0))
}

pub async fn set_enabled(
    pool: &SqlitePool,
    workspace: &str,
    on: bool,
) -> Result<bool, SchedulingError> {
    sqlx::query(
        "INSERT INTO reminder_settings (workspace_id, enabled) VALUES (?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET enabled = excluded.enabled",
    )
    .bind(workspace)
    .bind(on)
    .execute(pool)
    .await?;
    Ok(on)
}

pub async fn reminder(
    pool: &SqlitePool,
    workspace: &str,
    event: &str,
) -> Result<Option<i64>, SchedulingError> {
    if !event_exists(pool, workspace, event).await? {
        return Err(SchedulingError::NotFound);
    }
    Ok(sqlx::query_scalar(
        "SELECT minutes_before FROM event_reminders WHERE event_id = ? AND workspace_id = ?",
    )
    .bind(event)
    .bind(workspace)
    .fetch_optional(pool)
    .await?)
}

/// Sets or clears an event's reminder. Changing it makes earlier deliveries
/// for the old offset irrelevant, since deliveries are keyed by offset.
pub async fn set_reminder(
    pool: &SqlitePool,
    workspace: &str,
    event: &str,
    minutes: Option<i64>,
) -> Result<Option<i64>, SchedulingError> {
    if minutes.is_some_and(|value| !(0..=MAX_MINUTES).contains(&value)) {
        return Err(SchedulingError::InvalidReminder);
    }
    if !event_exists(pool, workspace, event).await? {
        return Err(SchedulingError::NotFound);
    }
    match minutes {
        Some(value) => {
            sqlx::query(
                "INSERT INTO event_reminders (event_id, workspace_id, minutes_before) VALUES (?, ?, ?)
                 ON CONFLICT (event_id) DO UPDATE SET minutes_before = excluded.minutes_before,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            )
            .bind(event)
            .bind(workspace)
            .bind(value)
            .execute(pool)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM event_reminders WHERE event_id = ? AND workspace_id = ?")
                .bind(event)
                .bind(workspace)
                .execute(pool)
                .await?;
        }
    }
    Ok(minutes)
}

/// Reminders that are due at `now` and not yet delivered, each marked
/// delivered as it is returned. Nothing is due while reminders are off.
pub async fn claim_due(
    pool: &SqlitePool,
    workspace: &str,
    now: Timestamp,
) -> Result<Vec<DueReminder>, SchedulingError> {
    if !enabled(pool, workspace).await? {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT event_id, minutes_before FROM event_reminders WHERE workspace_id = ?",
    )
    .bind(workspace)
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let offsets: HashMap<String, i64> = rows.into_iter().collect();
    let today = now.to_zoned(TimeZone::UTC).date();
    // Starts up to a week ahead can have a reminder due now.
    let (Some(from), Some(to)) = (time::add_days(today, -1), time::add_days(today, 9)) else {
        return Ok(Vec::new());
    };
    let items = list_items(
        pool,
        workspace,
        ItemRange {
            from: from.to_string(),
            to: to.to_string(),
            time_zone: "UTC".into(),
        },
    )
    .await?
    .items;
    let mut due = Vec::new();
    for item in items {
        let Some(reminder) = due_at(&item, &offsets, now) else {
            continue;
        };
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO reminder_deliveries
                 (event_id, occurrence, start_at, minutes_before, workspace_id)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&reminder.event_id)
        .bind(item.occurrence.as_deref().unwrap_or_default())
        .bind(&reminder.start_at)
        .bind(reminder.minutes_before)
        .bind(workspace)
        .execute(pool)
        .await?
        .rows_affected();
        if inserted == 1 {
            due.push(reminder);
        }
    }
    // Deliveries for starts long past no longer guard anything.
    sqlx::query("DELETE FROM reminder_deliveries WHERE workspace_id = ? AND start_at < ?")
        .bind(workspace)
        .bind(time::instant(now.checked_sub(48.hours()).unwrap_or(now)))
        .execute(pool)
        .await?;
    Ok(due)
}

/// The reminder for a timed event item if `now` is within `[start - offset, start)`.
fn due_at(
    item: &CalendarItem,
    offsets: &HashMap<String, i64>,
    now: Timestamp,
) -> Option<DueReminder> {
    if item.kind != ItemKind::Event || item.all_day {
        return None;
    }
    let event_id = item.event_id.as_ref()?;
    let minutes = *offsets.get(event_id)?;
    let start = time::parse_instant(item.start_at.as_deref()?)?;
    let remind = start.checked_sub(minutes.minutes()).ok()?;
    (remind <= now && now < start).then(|| DueReminder {
        event_id: event_id.clone(),
        title: item.title.clone(),
        start_at: time::instant(start),
        minutes_before: minutes,
    })
}

#[tauri::command]
pub async fn get_reminders_enabled(
    instances: State<'_, DbInstances>,
) -> Result<bool, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    enabled(&pool, &workspace).await
}

#[tauri::command]
pub async fn set_reminders_enabled(
    instances: State<'_, DbInstances>,
    enabled: bool,
) -> Result<bool, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    set_enabled(&pool, &workspace, enabled).await
}

#[tauri::command]
pub async fn get_event_reminder(
    instances: State<'_, DbInstances>,
    event_id: String,
) -> Result<Option<i64>, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    reminder(&pool, &workspace, &event_id).await
}

#[tauri::command]
pub async fn set_event_reminder(
    instances: State<'_, DbInstances>,
    event_id: String,
    minutes_before: Option<i64>,
) -> Result<Option<i64>, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    set_reminder(&pool, &workspace, &event_id, minutes_before).await
}

/// What one check delivered.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRun {
    pub delivered: Vec<DueReminder>,
    /// Reminders the system refused to show. They are not retried.
    pub failed: usize,
}

fn show<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) -> bool {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .is_ok()
}

fn body(reminder: &DueReminder) -> String {
    match reminder.minutes_before {
        0 => "Starting now.".to_owned(),
        1 => "Starts in 1 minute.".to_owned(),
        minutes if minutes < 60 => format!("Starts in {minutes} minutes."),
        minutes => format!("Starts in {} h {} min.", minutes / 60, minutes % 60),
    }
}

#[tauri::command]
pub async fn claim_due_reminders<R: Runtime>(
    app: AppHandle<R>,
    instances: State<'_, DbInstances>,
) -> Result<ReminderRun, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    let delivered = claim_due(&pool, &workspace, Timestamp::now()).await?;
    let failed = delivered
        .iter()
        .filter(|reminder| !show(&app, &reminder.title, &body(reminder)))
        .count();
    Ok(ReminderRun { delivered, failed })
}

/// Shows a notification now, so the user can check that the system allows
/// them. The app cannot read the system's notification setting on desktop.
#[tauri::command]
pub async fn send_test_notification<R: Runtime>(app: AppHandle<R>) -> Result<(), SchedulingError> {
    if show(&app, "Reminders are on", "This is a test notification.") {
        Ok(())
    } else {
        Err(SchedulingError::NotificationFailed)
    }
}

#[cfg(test)]
mod tests;
