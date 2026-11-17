//! Calendars, events, issue deadlines, and work blocks.
//!
//! docs/CALENDAR.md describes the scheduling contract. In short: events
//! belong to a calendar, deadlines are projected from `issues.due_date`
//! without rows of their own, and work blocks set time aside for an issue.
//! Every read and write is scoped to the active workspace.

pub(crate) mod calendars;
pub(crate) mod events;
pub(crate) mod links;
pub(crate) mod recurrence;
pub(crate) mod reminders;
pub(crate) mod search;
pub(crate) mod time;

use crate::database::{active_workspace, pool, DatabaseError};
use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

/// The longest window one read may cover.
pub const MAX_RANGE_DAYS: i64 = 400;
/// The most items one read returns. More sets `truncated`.
pub const MAX_ITEMS: usize = 2000;
/// The longest a single event or work block may last.
pub const MAX_ITEM_DAYS: i64 = 366;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum SchedulingError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    NotFound,
    /// The calendar does not exist in the active workspace.
    CalendarNotFound,
    /// The issue does not exist in the active workspace.
    IssueNotFound,
    /// The document does not exist in the active workspace.
    DocumentNotFound,
    /// The project does not exist in the active workspace.
    ProjectNotFound,
    /// A reminder is a whole number of minutes from 0 to a week.
    InvalidReminder,
    /// The system would not show a notification.
    NotificationFailed,
    InvalidTitle,
    InvalidLocation,
    /// Only http and https addresses with a host are accepted.
    InvalidUrl,
    InvalidName,
    InvalidDescription,
    InvalidColor,
    /// Another calendar in the workspace already has this name.
    DuplicateName,
    /// Archived calendars cannot become the default.
    CalendarArchived,
    /// Archiving the default needs an active replacement default.
    ReplacementRequired,
    /// The repeat rule is incomplete or out of range.
    InvalidRepeat,
    /// The event does not repeat.
    NotRecurring,
    /// The series has no occurrence with that original start.
    OccurrenceNotFound,
    /// A single occurrence cannot switch between all-day and timed.
    OccurrenceKind,
    InvalidTimeZone,
    InvalidDate,
    InvalidTime,
    /// The end is not after the start, or the item is too long.
    InvalidRange,
    /// The requested window is empty or longer than `MAX_RANGE_DAYS`.
    RangeTooLong,
    StorageFailed,
}

impl From<DatabaseError> for SchedulingError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

impl From<sqlx::Error> for SchedulingError {
    fn from(error: sqlx::Error) -> Self {
        eprintln!("Scheduling storage failed: {error}");
        Self::StorageFailed
    }
}

#[derive(Clone, Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub is_default: bool,
    pub hidden: bool,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) const CALENDAR_FIELDS: &str =
    "id, name, description, color, is_default, hidden, archived_at, created_at, updated_at";

#[derive(Clone, Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    pub description: String,
    pub location: Option<String>,
    pub url: Option<String>,
    pub all_day: bool,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub time_zone: Option<String>,
    pub start_local: Option<String>,
    pub end_local: Option<String>,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    /// `daily`, `weekly`, `monthly`, or `yearly` for a recurring event.
    pub repeat_freq: Option<String>,
    pub repeat_interval: Option<i64>,
    pub repeat_count: Option<i64>,
    /// The last date an occurrence may start on, inclusive.
    pub repeat_until: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) const EVENT_FIELDS: &str =
    "id, calendar_id, title, description, location, url, all_day, \
     start_date, end_date, time_zone, start_local, end_local, start_at, end_at, \
     repeat_freq, repeat_interval, repeat_count, repeat_until, created_at, updated_at";

/// The fields of a new or edited event. All-day events use `startDate` and
/// an exclusive `endDate`. Timed events use `timeZone`, `start`, and an
/// exclusive `end` as wall-clock times in that zone.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventInput {
    /// The default calendar when absent.
    pub calendar_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub location: Option<String>,
    pub url: Option<String>,
    pub all_day: bool,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub time_zone: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
    /// Makes the event recurring. `None` makes it a single event.
    #[serde(default)]
    pub repeat: Option<recurrence::RepeatRule>,
}

#[derive(Clone, Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBlock {
    pub id: String,
    pub issue_id: String,
    pub time_zone: String,
    pub start_local: String,
    pub end_local: String,
    pub start_at: String,
    pub end_at: String,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) const WORK_BLOCK_FIELDS: &str =
    "id, issue_id, time_zone, start_local, end_local, start_at, end_at, created_at, updated_at";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkBlockInput {
    pub issue_id: String,
    pub time_zone: String,
    pub start: String,
    pub end: String,
}

/// A new time for an existing work block.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkBlockTiming {
    pub time_zone: String,
    pub start: String,
    pub end: String,
}

/// A validated time span.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Timing {
    /// Calendar dates, end exclusive.
    AllDay { start: Date, end: Date },
    /// Wall-clock intent and resolved instants, end exclusive.
    Timed {
        zone: String,
        start_local: String,
        end_local: String,
        start_at: Timestamp,
        end_at: Timestamp,
    },
}

pub(crate) fn all_day_timing(
    start: Option<&str>,
    end: Option<&str>,
) -> Result<Timing, SchedulingError> {
    let start = start
        .and_then(time::date)
        .ok_or(SchedulingError::InvalidDate)?;
    let end = end
        .and_then(time::date)
        .ok_or(SchedulingError::InvalidDate)?;
    let days = (end - start).get_days() as i64;
    if end <= start || days > MAX_ITEM_DAYS {
        return Err(SchedulingError::InvalidRange);
    }
    Ok(Timing::AllDay { start, end })
}

pub(crate) fn timed_timing(
    zone_name: Option<&str>,
    start: Option<&str>,
    end: Option<&str>,
) -> Result<Timing, SchedulingError> {
    let zone_name = zone_name.ok_or(SchedulingError::InvalidTimeZone)?;
    let zone = time::zone(zone_name).ok_or(SchedulingError::InvalidTimeZone)?;
    let (start_local, end_local) = (
        start.ok_or(SchedulingError::InvalidTime)?,
        end.ok_or(SchedulingError::InvalidTime)?,
    );
    let start_at = time::wall_clock(start_local)
        .and_then(|local| time::resolve(local, &zone))
        .ok_or(SchedulingError::InvalidTime)?;
    let end_at = time::wall_clock(end_local)
        .and_then(|local| time::resolve(local, &zone))
        .ok_or(SchedulingError::InvalidTime)?;
    let seconds = end_at.as_second() - start_at.as_second();
    if seconds <= 0 || seconds > MAX_ITEM_DAYS * 86_400 {
        return Err(SchedulingError::InvalidRange);
    }
    Ok(Timing::Timed {
        zone: zone_name.to_owned(),
        start_local: start_local.to_owned(),
        end_local: end_local.to_owned(),
        start_at,
        end_at,
    })
}

pub(crate) fn event_timing(input: &EventInput) -> Result<Timing, SchedulingError> {
    if input.all_day {
        if input.time_zone.is_some() || input.start.is_some() || input.end.is_some() {
            return Err(SchedulingError::InvalidTime);
        }
        all_day_timing(input.start_date.as_deref(), input.end_date.as_deref())
    } else {
        if input.start_date.is_some() || input.end_date.is_some() {
            return Err(SchedulingError::InvalidDate);
        }
        timed_timing(
            input.time_zone.as_deref(),
            input.start.as_deref(),
            input.end.as_deref(),
        )
    }
}

/// Trims and checks the text fields. Empty location and URL become `None`.
pub(crate) fn clean_text(input: &mut EventInput) -> Result<(), SchedulingError> {
    input.title = input.title.trim().to_owned();
    if input.title.is_empty() || input.title.chars().count() > 200 || input.title.contains('\0') {
        return Err(SchedulingError::InvalidTitle);
    }
    if input.description.chars().count() > 10_000 || input.description.contains('\0') {
        return Err(SchedulingError::InvalidDescription);
    }
    input.location = input
        .location
        .take()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if input
        .location
        .as_ref()
        .is_some_and(|value| value.chars().count() > 200 || value.chars().any(char::is_control))
    {
        return Err(SchedulingError::InvalidLocation);
    }
    input.url = input
        .url
        .take()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if input.url.as_deref().is_some_and(|value| !valid_url(value)) {
        return Err(SchedulingError::InvalidUrl);
    }
    Ok(())
}

/// Accepts an `http` or `https` address with a host and no spaces or
/// control characters. Other schemes, such as `javascript:` or `file:`,
/// are refused, because the editor opens links.
pub(crate) fn valid_url(value: &str) -> bool {
    if value.len() > 2000 || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    else {
        return false;
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    let host = host.split(':').next().unwrap_or_default();
    !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']'))
}

/// The workspace's default calendar, created on first use. A partial unique
/// index keeps it to one even if two requests race.
pub(crate) async fn ensure_default(
    conn: &mut SqliteConnection,
    workspace: &str,
) -> Result<String, SchedulingError> {
    let find = "SELECT id FROM calendars WHERE workspace_id = ? AND is_default = 1";
    if let Some(id) = sqlx::query_scalar(find)
        .bind(workspace)
        .fetch_optional(&mut *conn)
        .await?
    {
        return Ok(id);
    }
    sqlx::query(
        "INSERT INTO calendars (id, workspace_id, name, color, is_default)
         VALUES (?, ?, 'Personal', 'blue', 1)
         ON CONFLICT (workspace_id) WHERE is_default = 1 DO NOTHING",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(workspace)
    .execute(&mut *conn)
    .await?;
    Ok(sqlx::query_scalar(find)
        .bind(workspace)
        .fetch_one(&mut *conn)
        .await?)
}

/// Checks that a calendar exists in the workspace and accepts new events.
pub(crate) async fn writable_calendar(
    conn: &mut SqliteConnection,
    workspace: &str,
    id: &str,
) -> Result<(), SchedulingError> {
    let archived: Option<Option<String>> =
        sqlx::query_scalar("SELECT archived_at FROM calendars WHERE id = ? AND workspace_id = ?")
            .bind(id)
            .bind(workspace)
            .fetch_optional(&mut *conn)
            .await?;
    match archived {
        Some(None) => Ok(()),
        // Archived calendars keep their events but take no new ones.
        _ => Err(SchedulingError::CalendarNotFound),
    }
}

pub async fn calendars_of(
    pool: &SqlitePool,
    workspace: &str,
) -> Result<Vec<Calendar>, SchedulingError> {
    let mut tx = pool.begin().await?;
    ensure_default(&mut tx, workspace).await?;
    let calendars = sqlx::query_as(&format!(
        "SELECT {CALENDAR_FIELDS} FROM calendars WHERE workspace_id = ?
         ORDER BY archived_at IS NOT NULL, is_default DESC, name COLLATE NOCASE, id"
    ))
    .bind(workspace)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(calendars)
}

pub(crate) fn bind_timing<'q>(
    query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    timing: &Timing,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match timing {
        Timing::AllDay { start, end } => query
            .bind(true)
            .bind(start.to_string())
            .bind(end.to_string())
            .bind(None::<String>)
            .bind(None::<String>)
            .bind(None::<String>)
            .bind(None::<String>)
            .bind(None::<String>),
        Timing::Timed {
            zone,
            start_local,
            end_local,
            start_at,
            end_at,
        } => query
            .bind(false)
            .bind(None::<String>)
            .bind(None::<String>)
            .bind(zone.clone())
            .bind(start_local.clone())
            .bind(end_local.clone())
            .bind(time::instant(*start_at))
            .bind(time::instant(*end_at)),
    }
}

pub async fn create_event(
    pool: &SqlitePool,
    workspace: &str,
    mut input: EventInput,
) -> Result<Event, SchedulingError> {
    clean_text(&mut input)?;
    let timing = event_timing(&input)?;
    let rule = recurrence::validate(&input.repeat, &timing)?;
    let mut tx = pool.begin().await?;
    let calendar = match input.calendar_id.clone() {
        Some(id) => {
            writable_calendar(&mut tx, workspace, &id).await?;
            id
        }
        None => ensure_default(&mut tx, workspace).await?,
    };
    let query = sqlx::query(
        "INSERT INTO events (id, workspace_id, calendar_id, title, description, location, url,
             all_day, start_date, end_date, time_zone, start_local, end_local, start_at, end_at,
             repeat_freq, repeat_interval, repeat_count, repeat_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let id = Uuid::new_v4().to_string();
    let query = query
        .bind(&id)
        .bind(workspace)
        .bind(&calendar)
        .bind(&input.title)
        .bind(&input.description)
        .bind(&input.location)
        .bind(&input.url);
    let (freq, interval, count, until) = recurrence::rule_columns(&rule);
    bind_timing(query, &timing)
        .bind(freq)
        .bind(interval)
        .bind(count)
        .bind(until)
        .execute(&mut *tx)
        .await?;
    let event = get_event_on(&mut tx, workspace, &id).await?;
    tx.commit().await?;
    Ok(event)
}

pub(crate) async fn get_event_on(
    conn: &mut SqliteConnection,
    workspace: &str,
    id: &str,
) -> Result<Event, SchedulingError> {
    sqlx::query_as(&format!(
        "SELECT {EVENT_FIELDS} FROM events WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(conn)
    .await?
    .ok_or(SchedulingError::NotFound)
}

pub async fn get_event(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
) -> Result<Event, SchedulingError> {
    let mut conn = pool.acquire().await?;
    get_event_on(&mut conn, workspace, id).await
}

pub async fn create_work_block(
    pool: &SqlitePool,
    workspace: &str,
    input: WorkBlockInput,
) -> Result<WorkBlock, SchedulingError> {
    let Timing::Timed {
        zone,
        start_local,
        end_local,
        start_at,
        end_at,
    } = timed_timing(Some(&input.time_zone), Some(&input.start), Some(&input.end))?
    else {
        unreachable!("timed_timing returns timed spans");
    };
    let mut tx = pool.begin().await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM issues WHERE id = ? AND workspace_id = ?)",
    )
    .bind(&input.issue_id)
    .bind(workspace)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(SchedulingError::IssueNotFound);
    }
    let block = sqlx::query_as(&format!(
        "INSERT INTO work_blocks (id, workspace_id, issue_id, time_zone, start_local, end_local, start_at, end_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING {WORK_BLOCK_FIELDS}"
    ))
    .bind(Uuid::new_v4().to_string())
    .bind(workspace)
    .bind(&input.issue_id)
    .bind(zone)
    .bind(start_local)
    .bind(end_local)
    .bind(time::instant(start_at))
    .bind(time::instant(end_at))
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(block)
}

/// Moves or resizes a work block. Its issue never changes, and neither do
/// the issue's status or due date.
pub async fn update_work_block(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    input: WorkBlockTiming,
) -> Result<WorkBlock, SchedulingError> {
    let Timing::Timed {
        zone,
        start_local,
        end_local,
        start_at,
        end_at,
    } = timed_timing(Some(&input.time_zone), Some(&input.start), Some(&input.end))?
    else {
        unreachable!("timed_timing returns timed spans");
    };
    sqlx::query_as(&format!(
        "UPDATE work_blocks SET time_zone = ?, start_local = ?, end_local = ?, start_at = ?, end_at = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND workspace_id = ? RETURNING {WORK_BLOCK_FIELDS}"
    ))
    .bind(zone)
    .bind(start_local)
    .bind(end_local)
    .bind(time::instant(start_at))
    .bind(time::instant(end_at))
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await?
    .ok_or(SchedulingError::NotFound)
}

/// Every work block of an issue, earliest first. Closed and archived issues
/// keep theirs, so the history stays readable.
pub async fn list_work_blocks(
    pool: &SqlitePool,
    workspace: &str,
    issue_id: &str,
) -> Result<Vec<WorkBlock>, SchedulingError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM issues WHERE id = ? AND workspace_id = ?)",
    )
    .bind(issue_id)
    .bind(workspace)
    .fetch_one(pool)
    .await?;
    if !exists {
        return Err(SchedulingError::IssueNotFound);
    }
    Ok(sqlx::query_as(&format!(
        "SELECT {WORK_BLOCK_FIELDS} FROM work_blocks
         WHERE issue_id = ? AND workspace_id = ? ORDER BY start_at, id"
    ))
    .bind(issue_id)
    .bind(workspace)
    .fetch_all(pool)
    .await?)
}

pub async fn delete_work_block(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
) -> Result<(), SchedulingError> {
    let deleted = sqlx::query("DELETE FROM work_blocks WHERE id = ? AND workspace_id = ?")
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

/// A window of calendar days in the viewer's zone, `to` exclusive.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemRange {
    pub from: String,
    pub to: String,
    pub time_zone: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Event,
    Deadline,
    WorkBlock,
}

/// One entry for a calendar view. Timed items carry their start and end as
/// wall-clock times in the viewer's zone, ready to place on a grid, plus the
/// instants and their own zone. Date-only items carry dates, end exclusive.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarItem {
    pub kind: ItemKind,
    /// Unique per item. An occurrence's is `{eventId}:{occurrence}`.
    pub id: String,
    /// The stored event an event item comes from.
    pub event_id: Option<String>,
    /// For occurrences of a recurring event, the original start that
    /// identifies the occurrence. It does not change when it is moved.
    pub occurrence: Option<String>,
    pub recurring: bool,
    pub title: String,
    pub calendar_id: Option<String>,
    pub color: Option<String>,
    pub issue_id: Option<String>,
    pub issue_number: Option<i64>,
    pub closed: bool,
    pub all_day: bool,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub time_zone: Option<String>,
    /// Timed items: wall-clock times in their own `time_zone`.
    pub local_start: Option<String>,
    pub local_end: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarItems {
    pub items: Vec<CalendarItem>,
    /// More than `MAX_ITEMS` matched; the earliest are returned.
    pub truncated: bool,
}

/// A validated read window: the days and the instants they span.
pub(crate) struct Window {
    pub from: Date,
    pub to: Date,
    pub zone: TimeZone,
    pub start_at: String,
    pub end_at: String,
    pub start: Timestamp,
    pub end: Timestamp,
}

pub(crate) fn window(range: &ItemRange) -> Result<Window, SchedulingError> {
    let zone = time::zone(&range.time_zone).ok_or(SchedulingError::InvalidTimeZone)?;
    let from = time::date(&range.from).ok_or(SchedulingError::InvalidDate)?;
    let to = time::date(&range.to).ok_or(SchedulingError::InvalidDate)?;
    let days = (to - from).get_days() as i64;
    if to <= from || days > MAX_RANGE_DAYS {
        return Err(SchedulingError::RangeTooLong);
    }
    let start_at = time::start_of_day(from, &zone).ok_or(SchedulingError::InvalidDate)?;
    let end_at = time::start_of_day(to, &zone).ok_or(SchedulingError::InvalidDate)?;
    Ok(Window {
        from,
        to,
        zone,
        start_at: time::instant(start_at),
        end_at: time::instant(end_at),
        start: start_at,
        end: end_at,
    })
}

#[derive(FromRow)]
pub(crate) struct EventRow {
    #[sqlx(flatten)]
    pub event: Event,
    pub color: String,
}

#[derive(FromRow)]
pub(crate) struct BlockRow {
    #[sqlx(flatten)]
    pub block: WorkBlock,
    pub title: String,
    pub number: i64,
    pub closed: bool,
}

/// An item with only its identity set.
pub(crate) fn blank(kind: ItemKind, id: String, title: String) -> CalendarItem {
    CalendarItem {
        kind,
        id,
        event_id: None,
        occurrence: None,
        recurring: false,
        title,
        calendar_id: None,
        color: None,
        issue_id: None,
        issue_number: None,
        closed: false,
        all_day: false,
        start_date: None,
        end_date: None,
        start: None,
        end: None,
        start_at: None,
        end_at: None,
        time_zone: None,
        local_start: None,
        local_end: None,
    }
}

/// Sets a timed span: the viewer's wall-clock times, the instants, and the
/// item's own zone and wall-clock times.
pub(crate) fn set_times(
    item: &mut CalendarItem,
    zone_name: &str,
    local: (&str, &str),
    instants: (&str, &str),
    window: &Window,
) {
    let viewer =
        |value: &str| time::parse_instant(value).map(|instant| time::local(instant, &window.zone));
    item.all_day = false;
    item.start = viewer(instants.0);
    item.end = viewer(instants.1);
    item.start_at = Some(instants.0.to_owned());
    item.end_at = Some(instants.1.to_owned());
    item.time_zone = Some(zone_name.to_owned());
    item.local_start = Some(local.0.to_owned());
    item.local_end = Some(local.1.to_owned());
}

pub(crate) fn set_dates(item: &mut CalendarItem, start: &str, end: &str) {
    item.all_day = true;
    item.start_date = Some(start.to_owned());
    item.end_date = Some(end.to_owned());
}

pub(crate) fn event_item(event: Event, color: String, window: &Window) -> CalendarItem {
    let mut item = blank(ItemKind::Event, event.id.clone(), event.title.clone());
    if event.all_day {
        set_dates(
            &mut item,
            event.start_date.as_deref().unwrap_or_default(),
            event.end_date.as_deref().unwrap_or_default(),
        );
    } else {
        set_times(
            &mut item,
            event.time_zone.as_deref().unwrap_or_default(),
            (
                event.start_local.as_deref().unwrap_or_default(),
                event.end_local.as_deref().unwrap_or_default(),
            ),
            (
                event.start_at.as_deref().unwrap_or_default(),
                event.end_at.as_deref().unwrap_or_default(),
            ),
            window,
        );
    }
    item.event_id = Some(event.id);
    item.calendar_id = Some(event.calendar_id);
    item.color = Some(color);
    item
}

/// A deadline projected from an issue's due date.
pub(crate) fn deadline_item(
    id: String,
    number: i64,
    title: String,
    due: &str,
    closed: bool,
) -> CalendarItem {
    let next = time::date(due)
        .and_then(|day| time::add_days(day, 1))
        .map(|day| day.to_string());
    let mut item = blank(ItemKind::Deadline, id.clone(), title);
    set_dates(&mut item, due, next.as_deref().unwrap_or_default());
    item.issue_id = Some(id);
    item.issue_number = Some(number);
    item.closed = closed;
    item
}

/// A work block, titled after its issue.
pub(crate) fn block_item(row: BlockRow, window: &Window) -> CalendarItem {
    let block = row.block;
    let mut item = blank(ItemKind::WorkBlock, block.id, row.title);
    set_times(
        &mut item,
        &block.time_zone,
        (&block.start_local, &block.end_local),
        (&block.start_at, &block.end_at),
        window,
    );
    item.issue_id = Some(block.issue_id);
    item.issue_number = Some(row.number);
    item.closed = row.closed;
    item
}

/// The bundled IANA time-zone database release, such as `2025b`.
pub(crate) fn tzdb_version() -> &'static str {
    jiff_tzdb::VERSION.unwrap_or("unknown")
}

/// Re-resolves stored UTC instants from their wall-clock intent when the
/// workspace last resolved them with a different time-zone database. The
/// intent is the source of truth, so a rules update moves the instant, not
/// the time the user chose. Unknown zones and ranges that a rule change
/// would invert are left as stored. Returns how many rows changed.
pub(crate) async fn refresh_instants(
    pool: &SqlitePool,
    workspace: &str,
    version: &str,
) -> Result<usize, SchedulingError> {
    let checked: Option<String> =
        sqlx::query_scalar("SELECT tzdb_version FROM scheduling_state WHERE workspace_id = ?")
            .bind(workspace)
            .fetch_optional(pool)
            .await?;
    if checked.as_deref() == Some(version) {
        return Ok(0);
    }
    let mut tx = pool.begin().await?;
    let mut changed = 0;
    for table in ["events", "work_blocks"] {
        let timed = if table == "events" {
            "AND all_day = 0"
        } else {
            ""
        };
        let rows: Vec<(String, String, String, String, String, String)> = sqlx::query_as(&format!(
            "SELECT id, time_zone, start_local, end_local, start_at, end_at FROM {table}
             WHERE workspace_id = ? {timed}"
        ))
        .bind(workspace)
        .fetch_all(&mut *tx)
        .await?;
        for (id, zone, start_local, end_local, start_at, end_at) in rows {
            let Some(zone) = time::zone(&zone) else {
                continue;
            };
            let resolve = |local: &str| {
                time::wall_clock(local)
                    .and_then(|local| time::resolve(local, &zone))
                    .map(time::instant)
            };
            let (Some(start), Some(end)) = (resolve(&start_local), resolve(&end_local)) else {
                continue;
            };
            if end <= start || (start == start_at && end == end_at) {
                continue;
            }
            // Not a user edit, so `updated_at` stays.
            sqlx::query(&format!(
                "UPDATE {table} SET start_at = ?, end_at = ? WHERE id = ?"
            ))
            .bind(&start)
            .bind(&end)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
            changed += 1;
        }
    }
    // Moved occurrences of recurring events use their event's zone.
    let moved: Vec<(String, String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT x.event_id, x.occurrence, e.time_zone, x.start_local, x.end_local, x.start_at, x.end_at
         FROM event_exceptions AS x JOIN events AS e ON e.id = x.event_id
         WHERE e.workspace_id = ? AND x.start_local IS NOT NULL AND e.time_zone IS NOT NULL",
    )
    .bind(workspace)
    .fetch_all(&mut *tx)
    .await?;
    for (event, occurrence, zone, start_local, end_local, start_at, end_at) in moved {
        let Some(zone) = time::zone(&zone) else {
            continue;
        };
        let resolve = |local: &str| {
            time::wall_clock(local)
                .and_then(|local| time::resolve(local, &zone))
                .map(time::instant)
        };
        let (Some(start), Some(end)) = (resolve(&start_local), resolve(&end_local)) else {
            continue;
        };
        if end <= start || (start == start_at && end == end_at) {
            continue;
        }
        sqlx::query(
            "UPDATE event_exceptions SET start_at = ?, end_at = ? WHERE event_id = ? AND occurrence = ?",
        )
        .bind(&start)
        .bind(&end)
        .bind(&event)
        .bind(&occurrence)
        .execute(&mut *tx)
        .await?;
        changed += 1;
    }
    sqlx::query(
        "INSERT INTO scheduling_state (workspace_id, tzdb_version) VALUES (?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET tzdb_version = excluded.tzdb_version",
    )
    .bind(workspace)
    .bind(version)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(changed)
}

/// Events, issue deadlines, and work blocks that overlap the window.
/// Events in hidden or archived calendars and archived issues are left out.
pub async fn list_items(
    pool: &SqlitePool,
    workspace: &str,
    range: ItemRange,
) -> Result<CalendarItems, SchedulingError> {
    let window = window(&range)?;
    refresh_instants(pool, workspace, tzdb_version()).await?;
    let (from, to) = (window.from.to_string(), window.to.to_string());
    let limit = MAX_ITEMS as i64 + 1;
    let mut conn = pool.acquire().await?;
    let event_fields = EVENT_FIELDS
        .split(", ")
        .map(|field| format!("e.{field}"))
        .collect::<Vec<_>>()
        .join(", ");
    let visible = "JOIN calendars AS c ON c.id = e.calendar_id
         WHERE e.workspace_id = ?1 AND c.archived_at IS NULL AND c.hidden = 0";
    let timed: Vec<EventRow> = sqlx::query_as(&format!(
        "SELECT {event_fields}, c.color FROM events AS e {visible}
           AND e.repeat_freq IS NULL AND e.all_day = 0 AND e.start_at < ?3 AND e.end_at > ?2
         ORDER BY e.start_at, e.id LIMIT ?4"
    ))
    .bind(workspace)
    .bind(&window.start_at)
    .bind(&window.end_at)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    let dated: Vec<EventRow> = sqlx::query_as(&format!(
        "SELECT {event_fields}, c.color FROM events AS e {visible}
           AND e.repeat_freq IS NULL AND e.all_day = 1 AND e.start_date < ?3 AND e.end_date > ?2
         ORDER BY e.start_date, e.id LIMIT ?4"
    ))
    .bind(workspace)
    .bind(&from)
    .bind(&to)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    // Deadlines are read from issues. Nothing is stored for them here.
    let deadlines: Vec<(String, i64, String, String, bool)> = sqlx::query_as(
        "SELECT id, number, title, due_date, status IN ('done', 'canceled')
         FROM issues
         WHERE workspace_id = ? AND archived_at IS NULL AND due_date >= ? AND due_date < ?
         ORDER BY due_date, number LIMIT ?",
    )
    .bind(workspace)
    .bind(&from)
    .bind(&to)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    let blocks: Vec<BlockRow> = sqlx::query_as(&format!(
        "SELECT {}, i.title, i.number, i.status IN ('done', 'canceled') AS closed
         FROM work_blocks AS b JOIN issues AS i ON i.id = b.issue_id
         WHERE b.workspace_id = ? AND i.archived_at IS NULL AND b.start_at < ? AND b.end_at > ?
         ORDER BY b.start_at, b.id LIMIT ?",
        WORK_BLOCK_FIELDS
            .split(", ")
            .map(|field| format!("b.{field}"))
            .collect::<Vec<_>>()
            .join(", ")
    ))
    .bind(workspace)
    .bind(&window.end_at)
    .bind(&window.start_at)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;

    let mut items: Vec<CalendarItem> = Vec::new();
    for row in timed.into_iter().chain(dated) {
        items.push(event_item(row.event, row.color, &window));
    }
    for (id, number, title, due, closed) in deadlines {
        items.push(deadline_item(id, number, title, &due, closed));
    }
    for row in blocks {
        items.push(block_item(row, &window));
    }
    // Recurring events are expanded for this window only.
    items.extend(recurrence::occurrences(&mut conn, workspace, &window, MAX_ITEMS + 1).await?);
    sort_items(&mut items);
    let truncated = items.len() > MAX_ITEMS;
    items.truncate(MAX_ITEMS);
    Ok(CalendarItems { items, truncated })
}

/// Orders items by start: dates before times on the same day, then by
/// end, title, and ID so the order is stable.
pub(crate) fn sort_items(items: &mut [CalendarItem]) {
    let key = |item: &CalendarItem| {
        let start = item
            .start_date
            .clone()
            .or_else(|| item.start.clone())
            .unwrap_or_default();
        let end = item
            .end_date
            .clone()
            .or_else(|| item.end.clone())
            .unwrap_or_default();
        (
            start,
            !item.all_day,
            end,
            item.title.to_lowercase(),
            item.id.clone(),
        )
    };
    items.sort_by_key(key);
}

pub(crate) async fn scope(
    instances: &DbInstances,
) -> Result<(SqlitePool, String), SchedulingError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn list_calendar_items(
    instances: State<'_, DbInstances>,
    range: ItemRange,
) -> Result<CalendarItems, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    list_items(&pool, &workspace, range).await
}

#[tauri::command]
pub async fn list_calendars(
    instances: State<'_, DbInstances>,
) -> Result<Vec<Calendar>, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    calendars_of(&pool, &workspace).await
}

#[tauri::command]
pub async fn create_calendar_event(
    instances: State<'_, DbInstances>,
    input: EventInput,
) -> Result<Event, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    create_event(&pool, &workspace, input).await
}

#[tauri::command]
pub async fn get_calendar_event(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Event, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    get_event(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn create_issue_work_block(
    instances: State<'_, DbInstances>,
    input: WorkBlockInput,
) -> Result<WorkBlock, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    create_work_block(&pool, &workspace, input).await
}

#[tauri::command]
pub async fn update_issue_work_block(
    instances: State<'_, DbInstances>,
    id: String,
    input: WorkBlockTiming,
) -> Result<WorkBlock, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    update_work_block(&pool, &workspace, &id, input).await
}

#[tauri::command]
pub async fn list_issue_work_blocks(
    instances: State<'_, DbInstances>,
    issue_id: String,
) -> Result<Vec<WorkBlock>, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    list_work_blocks(&pool, &workspace, &issue_id).await
}

#[tauri::command]
pub async fn delete_issue_work_block(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<(), SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    delete_work_block(&pool, &workspace, &id).await
}

#[cfg(test)]
mod tests;
