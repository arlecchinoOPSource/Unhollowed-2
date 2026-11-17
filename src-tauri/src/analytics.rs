//! The shared read contract for workspace analytics. docs/ANALYTICS.md writes
//! down every formula, boundary, and error.
//!
//! Everything here is a read over authoritative tables, scoped to the active
//! workspace, with nothing copied or cached. A request is a period of at most
//! 366 days (inclusive local dates), an optional project filter, and the
//! device time zone that turns local days into instants. Each source answers
//! in its own section with an explicit availability, so a card can tell
//! "none" from "does not apply" from "could not be read". A count of zero is a
//! real zero; a rate over nothing is `None`.

use crate::checkins::analytics::{analytics as mood_analytics, Metric};
use crate::database::{active_workspace, pool, DatabaseError};
use crate::habits::stats::{statistics, Streaks};
use crate::scheduling::{list_items, window, ItemKind, ItemRange};
use jiff::civil::Date;
use jiff::ToSpan;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashSet;
use tauri::State;
use tauri_plugin_sql::DbInstances;

/// The longest period a request may cover.
pub const MAX_DAYS: i64 = 366;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum AnalyticsError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    InvalidDate,
    /// The period ends before it starts or is over 366 days.
    InvalidRange,
    InvalidTimeZone,
    /// The project filter names a project that is not in this workspace.
    NotFound,
    StorageFailed,
}

impl From<DatabaseError> for AnalyticsError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

impl From<sqlx::Error> for AnalyticsError {
    fn from(error: sqlx::Error) -> Self {
        eprintln!("Analytics read failed: {error}");
        Self::StorageFailed
    }
}

impl From<crate::scheduling::SchedulingError> for AnalyticsError {
    fn from(error: crate::scheduling::SchedulingError) -> Self {
        use crate::scheduling::SchedulingError as E;
        match error {
            E::InvalidTimeZone => Self::InvalidTimeZone,
            E::InvalidDate => Self::InvalidDate,
            E::RangeTooLong => Self::InvalidRange,
            _ => Self::StorageFailed,
        }
    }
}

impl From<crate::habits::HabitError> for AnalyticsError {
    fn from(error: crate::habits::HabitError) -> Self {
        use crate::habits::HabitError as E;
        match error {
            E::DatabaseUnavailable => Self::DatabaseUnavailable,
            E::WorkspaceReadFailed => Self::WorkspaceReadFailed,
            _ => Self::StorageFailed,
        }
    }
}

impl From<crate::checkins::CheckinError> for AnalyticsError {
    fn from(error: crate::checkins::CheckinError) -> Self {
        use crate::checkins::CheckinError as E;
        match error {
            E::DatabaseUnavailable => Self::DatabaseUnavailable,
            E::WorkspaceReadFailed => Self::WorkspaceReadFailed,
            _ => Self::StorageFailed,
        }
    }
}

/// Whether a source answered, and why not if it did not.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    /// The active filter does not apply to this source, so it is left out
    /// instead of shown unfiltered.
    NotApplicable,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section<T> {
    pub availability: Availability,
    pub reason: Option<String>,
    pub data: Option<T>,
}

impl<T> Section<T> {
    fn of(data: T) -> Self {
        Self {
            availability: Availability::Available,
            reason: None,
            data: Some(data),
        }
    }
    fn not_applicable(reason: &str) -> Self {
        Self {
            availability: Availability::NotApplicable,
            reason: Some(reason.to_owned()),
            data: None,
        }
    }
}

fn percent(part: i64, whole: i64) -> Option<f64> {
    (whole > 0).then(|| part as f64 * 100.0 / whole as f64)
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub from: String,
    pub to: String,
    pub days: i64,
    pub today: String,
    pub time_zone: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueMetrics {
    /// Created in the period.
    pub created: i64,
    /// Completed (`done`) in the period.
    pub completed: i64,
    /// Not canceled and due in the period.
    pub due: i64,
    pub due_completed: i64,
    /// `due_completed / due`; `None` when nothing was due.
    pub due_percent: Option<f64>,
    /// As of today, not limited to the period.
    pub open: i64,
    /// Open and due before today.
    pub overdue: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetrics {
    /// As of today, by status.
    pub planned: i64,
    pub active: i64,
    pub on_hold: i64,
    pub completed: i64,
    pub archived: i64,
    /// Not archived, with a target date in the period.
    pub target_in_period: i64,
    pub target_completed: i64,
    /// Planned, active, or on hold with a target date before today.
    pub overdue: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveMetrics {
    pub objectives: i64,
    /// Linked issues that are not canceled.
    pub linked_issues: i64,
    pub linked_done: i64,
    pub done_percent: Option<f64>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneMetrics {
    /// As of today.
    pub open: i64,
    pub due_in_period: i64,
    pub closed_of_due: i64,
    /// Open with a due date before today.
    pub overdue: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMetrics {
    /// Event occurrences overlapping the period.
    pub events: i64,
    pub all_day_events: i64,
    pub timed_events: i64,
    /// Whole minutes of the timed occurrences.
    pub scheduled_minutes: i64,
    pub work_blocks: i64,
    pub work_block_minutes: i64,
    /// More items matched than the calendar returns, so these are lower bounds.
    pub truncated: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitMetrics {
    pub eligible: i64,
    pub completed: i64,
    pub percent: Option<f64>,
    pub practice: Streaks,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoodMetrics {
    pub days_recorded: i64,
    pub days_in_period: i64,
    pub mood: Metric,
    pub energy: Metric,
    pub focus: Metric,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAnalytics {
    pub period: Period,
    pub project_id: Option<String>,
    pub issues: Section<IssueMetrics>,
    pub projects: Section<ProjectMetrics>,
    pub objectives: Section<ObjectiveMetrics>,
    pub milestones: Section<MilestoneMetrics>,
    pub calendar: Section<CalendarMetrics>,
    pub habits: Section<HabitMetrics>,
    pub mood: Section<MoodMetrics>,
}

fn civil(date: &str) -> Result<Date, AnalyticsError> {
    date.parse::<Date>()
        .ok()
        .filter(|parsed| date.len() == 10 && parsed.to_string() == date && parsed.year() >= 1900)
        .ok_or(AnalyticsError::InvalidDate)
}

/// The analytics for `from..=to`, optionally for one project. `today` is the
/// device's local date; `time_zone` maps local days to instants.
pub async fn workspace_analytics(
    pool: &SqlitePool,
    workspace: &str,
    from: &str,
    to: &str,
    project: Option<&str>,
    time_zone: &str,
    today: &str,
) -> Result<WorkspaceAnalytics, AnalyticsError> {
    let (first, last) = (civil(from)?, civil(to)?);
    civil(today)?;
    let days = first.until(last).map_or(i64::MAX, |s| s.get_days() as i64) + 1;
    if first > last || days > MAX_DAYS {
        return Err(AnalyticsError::InvalidRange);
    }
    if let Some(id) = project {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?")
                .bind(id)
                .bind(workspace)
                .fetch_optional(pool)
                .await?;
        if found.is_none() {
            return Err(AnalyticsError::NotFound);
        }
    }
    // The period as instants in the device zone. The calendar's window is end
    // exclusive, so ask for the day after `to`.
    let after = last
        .checked_add(1.day())
        .map_err(|_| AnalyticsError::InvalidDate)?;
    let range = ItemRange {
        from: from.to_owned(),
        to: after.to_string(),
        time_zone: time_zone.to_owned(),
    };
    let span = window(&range)?;
    // Whole seconds, so fractional stored timestamps compare correctly.
    let (start, end) = (span.start_at[..19].to_owned(), span.end_at[..19].to_owned());

    let issues = issue_metrics(pool, workspace, project, (from, to), (&start, &end), today).await?;
    let projects = project_metrics(pool, workspace, project, (from, to), today).await?;
    let objectives = objective_metrics(pool, workspace, project).await?;
    let milestones = milestone_metrics(pool, workspace, project, (from, to), today).await?;
    let calendar = calendar_metrics(pool, workspace, project, range).await?;

    let (habits, mood) = if project.is_some() {
        let why = "Habits and check-ins do not belong to a project, so the project filter does not apply.";
        (Section::not_applicable(why), Section::not_applicable(why))
    } else {
        let h = statistics(pool, workspace, from, to, None, today).await?;
        // Check-ins allow about ten years, which covers every period here.
        let m = mood_analytics(pool, workspace, from, to, false, today).await?;
        (
            Section::of(HabitMetrics {
                eligible: h.summary.eligible,
                completed: h.summary.completed,
                percent: h.summary.percent,
                practice: h.practice,
            }),
            Section::of(MoodMetrics {
                days_recorded: m.days_recorded,
                days_in_period: m.days_in_period,
                mood: m.mood,
                energy: m.energy,
                focus: m.focus,
            }),
        )
    };
    Ok(WorkspaceAnalytics {
        period: Period {
            from: from.to_owned(),
            to: to.to_owned(),
            days,
            today: today.to_owned(),
            time_zone: time_zone.to_owned(),
        },
        project_id: project.map(str::to_owned),
        issues: Section::of(issues),
        projects: Section::of(projects),
        objectives: Section::of(objectives),
        milestones: Section::of(milestones),
        calendar: Section::of(calendar),
        habits,
        mood,
    })
}

async fn issue_metrics(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
    (from, to): (&str, &str),
    (start, end): (&str, &str),
    today: &str,
) -> Result<IssueMetrics, AnalyticsError> {
    let (created, completed, due, due_completed, open, overdue): (i64, i64, i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT
                coalesce(sum(substr(created_at, 1, 19) >= ?3 AND substr(created_at, 1, 19) < ?4), 0),
                coalesce(sum(status = 'done' AND completed_at IS NOT NULL
                    AND substr(completed_at, 1, 19) >= ?3 AND substr(completed_at, 1, 19) < ?4), 0),
                coalesce(sum(status != 'canceled' AND due_date BETWEEN ?5 AND ?6), 0),
                coalesce(sum(status = 'done' AND due_date BETWEEN ?5 AND ?6), 0),
                coalesce(sum(status NOT IN ('done', 'canceled')), 0),
                coalesce(sum(status NOT IN ('done', 'canceled') AND due_date < ?7), 0)
             FROM issues
             WHERE workspace_id = ?1 AND archived_at IS NULL AND (?2 IS NULL OR project_id = ?2)",
        )
        .bind(workspace)
        .bind(project)
        .bind(start)
        .bind(end)
        .bind(from)
        .bind(to)
        .bind(today)
        .fetch_one(pool)
        .await?;
    Ok(IssueMetrics {
        created,
        completed,
        due,
        due_completed,
        due_percent: percent(due_completed, due),
        open,
        overdue,
    })
}

async fn project_metrics(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
    (from, to): (&str, &str),
    today: &str,
) -> Result<ProjectMetrics, AnalyticsError> {
    let row: (i64, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
            coalesce(sum(status = 'planned'), 0), coalesce(sum(status = 'active'), 0),
            coalesce(sum(status = 'on_hold'), 0), coalesce(sum(status = 'completed'), 0),
            coalesce(sum(status = 'archived'), 0),
            coalesce(sum(status != 'archived' AND target_date BETWEEN ?3 AND ?4), 0),
            coalesce(sum(status = 'completed' AND target_date BETWEEN ?3 AND ?4), 0),
            coalesce(sum(status IN ('planned', 'active', 'on_hold') AND target_date < ?5), 0)
         FROM projects WHERE workspace_id = ?1 AND (?2 IS NULL OR id = ?2)",
    )
    .bind(workspace)
    .bind(project)
    .bind(from)
    .bind(to)
    .bind(today)
    .fetch_one(pool)
    .await?;
    Ok(ProjectMetrics {
        planned: row.0,
        active: row.1,
        on_hold: row.2,
        completed: row.3,
        archived: row.4,
        target_in_period: row.5,
        target_completed: row.6,
        overdue: row.7,
    })
}

async fn objective_metrics(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
) -> Result<ObjectiveMetrics, AnalyticsError> {
    let objectives: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM objectives AS o JOIN projects AS p ON p.id = o.project_id
         WHERE p.workspace_id = ?1 AND (?2 IS NULL OR p.id = ?2)",
    )
    .bind(workspace)
    .bind(project)
    .fetch_one(pool)
    .await?;
    let (linked, done): (i64, i64) = sqlx::query_as(
        "SELECT count(DISTINCT i.id), coalesce(count(DISTINCT CASE WHEN i.status = 'done' THEN i.id END), 0)
         FROM objective_issues AS l
         JOIN objectives AS o ON o.id = l.objective_id
         JOIN projects AS p ON p.id = o.project_id
         JOIN issues AS i ON i.id = l.issue_id AND i.workspace_id = p.workspace_id
         WHERE p.workspace_id = ?1 AND (?2 IS NULL OR p.id = ?2)
           AND i.status != 'canceled' AND i.archived_at IS NULL",
    )
    .bind(workspace)
    .bind(project)
    .fetch_one(pool)
    .await?;
    Ok(ObjectiveMetrics {
        objectives,
        linked_issues: linked,
        linked_done: done,
        done_percent: percent(done, linked),
    })
}

async fn milestone_metrics(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
    (from, to): (&str, &str),
    today: &str,
) -> Result<MilestoneMetrics, AnalyticsError> {
    let (open, due, closed, overdue): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
            coalesce(sum(state = 'open'), 0),
            coalesce(sum(due_date BETWEEN ?3 AND ?4), 0),
            coalesce(sum(state = 'closed' AND due_date BETWEEN ?3 AND ?4), 0),
            coalesce(sum(state = 'open' AND due_date < ?5), 0)
         FROM milestones WHERE workspace_id = ?1 AND (?2 IS NULL OR project_id = ?2)",
    )
    .bind(workspace)
    .bind(project)
    .bind(from)
    .bind(to)
    .bind(today)
    .fetch_one(pool)
    .await?;
    Ok(MilestoneMetrics {
        open,
        due_in_period: due,
        closed_of_due: closed,
        overdue,
    })
}

fn minutes(start: &Option<String>, end: &Option<String>) -> i64 {
    match (start, end) {
        (Some(start), Some(end)) => match (
            start.parse::<jiff::Timestamp>(),
            end.parse::<jiff::Timestamp>(),
        ) {
            (Ok(start), Ok(end)) => ((end.as_second() - start.as_second()) / 60).max(0),
            _ => 0,
        },
        _ => 0,
    }
}

async fn calendar_metrics(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
    range: ItemRange,
) -> Result<CalendarMetrics, AnalyticsError> {
    let found = list_items(pool, workspace, range).await?;
    // With a project filter only what is tied to that project counts: events
    // linked to it and work blocks on its issues.
    let (events, issues): (HashSet<String>, HashSet<String>) = match project {
        Some(id) => {
            let events: Vec<String> = sqlx::query_scalar(
                "SELECT event_id FROM event_projects WHERE project_id = ? AND workspace_id = ?",
            )
            .bind(id)
            .bind(workspace)
            .fetch_all(pool)
            .await?;
            let issues: Vec<String> = sqlx::query_scalar(
                "SELECT id FROM issues WHERE project_id = ? AND workspace_id = ?",
            )
            .bind(id)
            .bind(workspace)
            .fetch_all(pool)
            .await?;
            (events.into_iter().collect(), issues.into_iter().collect())
        }
        None => (HashSet::new(), HashSet::new()),
    };
    let mut metrics = CalendarMetrics {
        events: 0,
        all_day_events: 0,
        timed_events: 0,
        scheduled_minutes: 0,
        work_blocks: 0,
        work_block_minutes: 0,
        truncated: found.truncated,
    };
    for item in &found.items {
        match item.kind {
            ItemKind::Event => {
                let wanted = project.is_none()
                    || item.event_id.as_ref().is_some_and(|id| events.contains(id));
                if !wanted {
                    continue;
                }
                metrics.events += 1;
                if item.all_day {
                    metrics.all_day_events += 1;
                } else {
                    metrics.timed_events += 1;
                    metrics.scheduled_minutes += minutes(&item.start_at, &item.end_at);
                }
            }
            ItemKind::WorkBlock => {
                let wanted = project.is_none()
                    || item.issue_id.as_ref().is_some_and(|id| issues.contains(id));
                if wanted {
                    metrics.work_blocks += 1;
                    metrics.work_block_minutes += minutes(&item.start_at, &item.end_at);
                }
            }
            ItemKind::Deadline => {}
        }
    }
    Ok(metrics)
}

#[tauri::command]
pub async fn get_workspace_analytics(
    instances: State<'_, DbInstances>,
    from: String,
    to: String,
    project_id: Option<String>,
    time_zone: String,
) -> Result<WorkspaceAnalytics, AnalyticsError> {
    let instance = pool(&instances).await?;
    let workspace = active_workspace(&instance).await?;
    workspace_analytics(
        &instance,
        &workspace.id,
        &from,
        &to,
        project_id.as_deref(),
        &time_zone,
        &jiff::Zoned::now().date().to_string(),
    )
    .await
}

#[cfg(test)]
mod tests;
