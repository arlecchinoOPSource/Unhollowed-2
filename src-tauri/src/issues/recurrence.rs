//! Recurring issues. The rules are documented in docs/DATA_MODEL.md under
//! "Recurring issues".
//!
//! Dates here are local calendar dates (YYYY-MM-DD). The arithmetic works on
//! day numbers with no time zone, so daylight saving cannot move an
//! occurrence.

use super::{get, search_text, storage_failed, valid_date, Issue, IssueError, NOW};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

pub const FREQUENCIES: [&str; 3] = ["daily", "weekly", "monthly"];
pub const MAX_INTERVAL: i64 = 99;
/// Upper bound when skipping missed dates, far beyond any real gap.
const MAX_SKIP: i64 = 100_000;

// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
// days_from_civil), and the inverse.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = if month_part < 10 {
        month_part + 3
    } else {
        month_part - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn parse(date: &str) -> (i64, i64, i64) {
    let part = |range: std::ops::Range<usize>| date[range].parse::<i64>().unwrap_or(1);
    (part(0..4), part(5..7), part(8..10))
}

fn format((year, month, day): (i64, i64, i64)) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

fn days_in_month(year: i64, month: i64) -> i64 {
    let next = if month == 12 {
        days_from_civil(year + 1, 1, 1)
    } else {
        days_from_civil(year, month + 1, 1)
    };
    next - days_from_civil(year, month, 1)
}

/// The number of days from `from` to `to`.
pub fn days_between(from: &str, to: &str) -> i64 {
    let (a, b) = (parse(from), parse(to));
    days_from_civil(b.0, b.1, b.2) - days_from_civil(a.0, a.1, a.2)
}

pub fn add_days(date: &str, days: i64) -> String {
    let (year, month, day) = parse(date);
    format(civil_from_days(days_from_civil(year, month, day) + days))
}

/// The scheduled date of occurrence `index`, always computed from the anchor.
/// Monthly dates use the anchor's day of the month, or the month's last day
/// when it is shorter.
pub fn occurrence_date(anchor: &str, frequency: &str, interval: i64, index: i64) -> String {
    match frequency {
        "daily" => add_days(anchor, index * interval),
        "weekly" => add_days(anchor, 7 * index * interval),
        _ => {
            let (year, month, day) = parse(anchor);
            let months = year * 12 + (month - 1) + index * interval;
            let (year, month) = (months.div_euclid(12), months.rem_euclid(12) + 1);
            format((year, month, day.min(days_in_month(year, month))))
        }
    }
}

/// The index of the occurrence after `current`. When `today` is known,
/// missed dates are skipped, giving the first scheduled date on or after it.
pub fn next_index(
    anchor: &str,
    frequency: &str,
    interval: i64,
    current: i64,
    today: Option<&str>,
) -> i64 {
    let mut index = current + 1;
    if let Some(today) = today {
        let limit = index + MAX_SKIP;
        while index < limit && occurrence_date(anchor, frequency, interval, index).as_str() < today
        {
            index += 1;
        }
    }
    index
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurrenceInput {
    pub frequency: String,
    pub interval: i64,
}

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recurrence {
    pub id: String,
    pub frequency: String,
    pub interval: i64,
    pub anchor_date: String,
    pub stopped: bool,
    pub stopped_at: Option<String>,
    /// The latest occurrence in the series, which is the one new
    /// completions build on.
    pub latest_issue_id: String,
    pub latest_number: i64,
    pub latest_due_date: Option<String>,
    pub latest_closed: bool,
}

/// The schedule of the issue's series, if it has one.
pub async fn recurrence_for(
    pool: &SqlitePool,
    workspace: &str,
    issue: &str,
) -> Result<Option<Recurrence>, IssueError> {
    get(pool, workspace, issue).await?;
    sqlx::query_as(
        "SELECT r.id, r.frequency, r.interval_count AS interval, r.anchor_date,
                r.stopped_at IS NOT NULL AS stopped, r.stopped_at,
                l.id AS latest_issue_id, l.number AS latest_number,
                l.due_date AS latest_due_date, l.closed AS latest_closed
         FROM issues AS i
         JOIN issue_recurrences AS r ON r.id = i.recurrence_id
         JOIN issues AS l ON l.id = (
             SELECT id FROM issues WHERE recurrence_id = r.id
             ORDER BY occurrence_index DESC LIMIT 1)
         WHERE i.id = ? AND i.workspace_id = ?",
    )
    .bind(issue)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)
}

/// Sets, changes, or stops (`None`) an issue's repeat rule.
///
/// Setting or changing a rule starts a new series anchored on the issue's
/// due date, with the issue as occurrence 0, and stops any earlier series so
/// past occurrences keep their schedule. Repeating the current active rule
/// changes nothing. Stopping keeps every existing occurrence.
pub async fn set_rule(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    rule: Option<RecurrenceInput>,
) -> Result<Issue, IssueError> {
    if let Some(rule) = &rule {
        if !FREQUENCIES.contains(&rule.frequency.as_str())
            || !(1..=MAX_INTERVAL).contains(&rule.interval)
        {
            return Err(IssueError::InvalidRecurrence);
        }
    }
    let mut transaction = pool.begin().await.map_err(storage_failed)?;
    lock(&mut transaction, workspace, id).await?;
    let (due, series): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT due_date, recurrence_id FROM issues WHERE id = ? AND workspace_id = ?",
    )
    .bind(id)
    .bind(workspace)
    .fetch_one(&mut *transaction)
    .await
    .map_err(storage_failed)?;
    let active: Option<(String, i64)> = sqlx::query_as(
        "SELECT frequency, interval_count FROM issue_recurrences
         WHERE id = ? AND stopped_at IS NULL",
    )
    .bind(&series)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(storage_failed)?;
    match rule {
        None => {
            sqlx::query(&format!(
                "UPDATE issue_recurrences SET stopped_at = {NOW}, updated_at = {NOW}
                 WHERE id = ? AND stopped_at IS NULL"
            ))
            .bind(&series)
            .execute(&mut *transaction)
            .await
            .map_err(storage_failed)?;
        }
        Some(rule) if active == Some((rule.frequency.clone(), rule.interval)) => {}
        Some(rule) => {
            let anchor = due.ok_or(IssueError::RecurrenceNeedsDueDate)?;
            sqlx::query(&format!(
                "UPDATE issue_recurrences SET stopped_at = {NOW}, updated_at = {NOW}
                 WHERE id = ? AND stopped_at IS NULL"
            ))
            .bind(&series)
            .execute(&mut *transaction)
            .await
            .map_err(storage_failed)?;
            let new_series = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO issue_recurrences
                     (id, workspace_id, frequency, interval_count, anchor_date)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&new_series)
            .bind(workspace)
            .bind(&rule.frequency)
            .bind(rule.interval)
            .bind(&anchor)
            .execute(&mut *transaction)
            .await
            .map_err(storage_failed)?;
            sqlx::query(&format!(
                "UPDATE issues SET recurrence_id = ?, occurrence_index = 0, updated_at = {NOW}
                 WHERE id = ? AND workspace_id = ?"
            ))
            .bind(&new_series)
            .bind(id)
            .bind(workspace)
            .execute(&mut *transaction)
            .await
            .map_err(storage_failed)?;
        }
    }
    transaction.commit().await.map_err(storage_failed)?;
    get(pool, workspace, id).await
}

/// Takes SQLite's write lock with a no-op write, so the reads that follow in
/// the transaction cannot fail when it later writes. Fails with `NotFound`
/// when the issue is not in the workspace.
pub(super) async fn lock(
    transaction: &mut Transaction<'_, Sqlite>,
    workspace: &str,
    id: &str,
) -> Result<(), IssueError> {
    let found = sqlx::query("UPDATE issues SET status = status WHERE id = ? AND workspace_id = ?")
        .bind(id)
        .bind(workspace)
        .execute(&mut **transaction)
        .await
        .map_err(storage_failed)?
        .rows_affected();
    if found == 0 {
        return Err(IssueError::NotFound);
    }
    Ok(())
}

/// Creates the next occurrence after `issue` entered Done or Canceled, in the
/// caller's transaction. Does nothing when the issue has no active series or
/// a later occurrence already exists, so retries never duplicate it.
pub(super) async fn advance(
    transaction: &mut Transaction<'_, Sqlite>,
    workspace: &str,
    issue: &str,
    today: Option<&str>,
) -> Result<(), IssueError> {
    // Series, index, rule, and the fields the next occurrence copies.
    #[allow(clippy::type_complexity)]
    let current: Option<(
        String,
        i64,
        String,
        i64,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT r.id, i.occurrence_index, r.frequency, r.interval_count, r.anchor_date,
                i.title, i.description, i.priority, i.project_id, i.start_date, i.due_date
         FROM issues AS i JOIN issue_recurrences AS r ON r.id = i.recurrence_id
         WHERE i.id = ? AND i.workspace_id = ? AND r.stopped_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM issues AS later
                           WHERE later.recurrence_id = r.id
                             AND later.occurrence_index > i.occurrence_index)",
    )
    .bind(issue)
    .bind(workspace)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(storage_failed)?;
    let Some((
        series,
        index,
        frequency,
        interval,
        anchor,
        title,
        description,
        priority,
        project,
        start,
        due,
    )) = current
    else {
        return Ok(());
    };
    let next = next_index(&anchor, &frequency, interval, index, today);
    let next_due = occurrence_date(&anchor, &frequency, interval, next);
    // Keep the gap between start and due dates.
    let next_start = match (&start, &due) {
        (Some(start), Some(due)) => Some(add_days(&next_due, -days_between(start, due))),
        _ => None,
    };
    let number: i64 = sqlx::query_scalar(
        "INSERT INTO issue_counters (workspace_id, last_number) VALUES (?, 1)
         ON CONFLICT (workspace_id) DO UPDATE SET last_number = last_number + 1
         RETURNING last_number",
    )
    .bind(workspace)
    .fetch_one(&mut **transaction)
    .await
    .map_err(storage_failed)?;
    let new_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO issues
             (id, workspace_id, number, project_id, title, description, priority,
              start_date, due_date, search_text, recurrence_id, occurrence_index, milestone_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                (SELECT m.id FROM milestones AS m
                 JOIN issues AS old ON old.milestone_id = m.id
                 WHERE old.id = ? AND m.state = 'open')",
    )
    .bind(&new_id)
    .bind(workspace)
    .bind(number)
    .bind(&project)
    .bind(&title)
    .bind(&description)
    .bind(priority)
    .bind(next_start)
    .bind(&next_due)
    .bind(search_text(&title, &description))
    .bind(&series)
    .bind(next)
    .bind(issue)
    .execute(&mut **transaction)
    .await
    .map_err(storage_failed)?;
    sqlx::query(
        "INSERT INTO issue_labels (issue_id, label_id, workspace_id)
         SELECT ?, il.label_id, il.workspace_id
         FROM issue_labels AS il JOIN labels AS l ON l.id = il.label_id
         WHERE il.issue_id = ? AND l.archived_at IS NULL",
    )
    .bind(&new_id)
    .bind(issue)
    .execute(&mut **transaction)
    .await
    .map_err(storage_failed)?;
    Ok(())
}

/// Whether a date sent by the webview can be used for skipping missed dates.
pub(super) fn valid_today(today: Option<&str>) -> Result<(), IssueError> {
    if today.is_some_and(|date| !valid_date(date)) {
        return Err(IssueError::InvalidDate);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
