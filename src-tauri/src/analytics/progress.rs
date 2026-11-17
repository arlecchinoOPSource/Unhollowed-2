//! Project and issue progress: totals, per-project rollups, deadlines, and the
//! completion trend. docs/ANALYTICS.md, "Progress", defines every number.
//!
//! The denominators are the project overview's, so a card and its project
//! screen agree for the same filter: archived issues are never counted, a
//! canceled issue is neither done nor outstanding, and the completion rate is
//! done ÷ (all − canceled), `None` when that is zero. Milestone completion is
//! the milestone's own state; issue progress is never used in its place.
//!
//! The trend uses the stored `completed_at` of issues that are done now. A
//! reopened or canceled issue has no completion time and is not in it, and an
//! issue completed before timestamps were kept cannot be placed, so the
//! coverage is reported beside every trend instead of being filled in.

use super::{civil, AnalyticsError, MAX_DAYS};
use crate::database::{active_workspace, pool};
use crate::scheduling::{window, ItemRange};
use jiff::civil::Date;
use jiff::ToSpan;
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use std::collections::BTreeMap;
use tauri::State;
use tauri_plugin_sql::DbInstances;

/// Open issues and milestones due this far ahead are listed as deadlines.
const DEADLINE_DAYS: i64 = 13;
/// The overview's "upcoming" window: today through the next 6 days.
const UPCOMING_DAYS: i64 = 6;
const DEADLINE_LIMIT: i64 = 20;
/// Periods longer than this are shown by week instead of by day.
const DAILY_LIMIT: i64 = 92;

fn percent(part: i64, whole: i64) -> Option<f64> {
    (whole > 0).then(|| part as f64 * 100.0 / whole as f64)
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    /// Issues that are not archived.
    pub total: i64,
    pub open: i64,
    pub done: i64,
    pub canceled: i64,
    /// `done / (total - canceled) × 100`, or `None` when that is zero.
    pub completion_percent: Option<f64>,
    /// Open and due before today.
    pub overdue: i64,
    /// Open and due from today through the next 6 days.
    pub upcoming: i64,
    pub undated_open: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProgress {
    pub project_id: String,
    pub name: String,
    pub status: String,
    pub issues: Totals,
    pub milestones_open: i64,
    pub milestones_closed: i64,
    pub objectives: i64,
    pub objective_linked: i64,
    pub objective_done: i64,
}

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deadline {
    /// `issue` or `milestone`.
    pub kind: String,
    pub id: String,
    /// The issue's number; `None` for a milestone.
    pub number: Option<i64>,
    pub title: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub due_date: String,
    pub overdue: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendBucket {
    pub start: String,
    pub end: String,
    pub completed: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trend {
    /// `day`, or `week` (Monday to Sunday) for periods over 92 days.
    pub granularity: String,
    pub buckets: Vec<TrendBucket>,
    /// Issues that are done now.
    pub done_total: i64,
    /// Of those, the ones with a stored completion time.
    pub with_time: i64,
    /// Done issues that cannot be placed on the trend.
    pub without_time: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressAnalytics {
    pub from: String,
    pub to: String,
    pub today: String,
    pub project_id: Option<String>,
    pub totals: Totals,
    /// Projects that are not archived, by name; just the filtered one when filtered.
    pub projects: Vec<ProjectProgress>,
    /// Open issues and milestones overdue or due in the next 14 days, by date.
    pub deadlines: Vec<Deadline>,
    pub trend: Trend,
}

fn add_days(date: &str, days: i64) -> String {
    crate::issues::add_days(date, days)
}

async fn totals(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
    today: &str,
) -> Result<Totals, AnalyticsError> {
    let horizon = add_days(today, UPCOMING_DAYS);
    let (done, canceled, open, overdue, upcoming, undated): (i64, i64, i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT
                coalesce(sum(status = 'done'), 0),
                coalesce(sum(status = 'canceled'), 0),
                coalesce(sum(closed = 0), 0),
                coalesce(sum(closed = 0 AND due_date < ?3), 0),
                coalesce(sum(closed = 0 AND due_date >= ?3 AND due_date <= ?4), 0),
                coalesce(sum(closed = 0 AND due_date IS NULL), 0)
             FROM issues
             WHERE workspace_id = ?1 AND archived_at IS NULL AND (?2 IS NULL OR project_id = ?2)",
        )
        .bind(workspace)
        .bind(project)
        .bind(today)
        .bind(&horizon)
        .fetch_one(pool)
        .await?;
    let total = open + done + canceled;
    Ok(Totals {
        total,
        open,
        done,
        canceled,
        completion_percent: percent(done, total - canceled),
        overdue,
        upcoming,
        undated_open: undated,
    })
}

async fn per_project(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
    today: &str,
) -> Result<Vec<ProjectProgress>, AnalyticsError> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, name, status FROM projects
         WHERE workspace_id = ?1 AND (?2 IS NULL OR id = ?2)
           AND (?2 IS NOT NULL OR status != 'archived')
         ORDER BY name COLLATE NOCASE, id",
    )
    .bind(workspace)
    .bind(project)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::new();
    for (id, name, status) in rows {
        let issues = totals(pool, workspace, Some(&id), today).await?;
        let (open, closed): (i64, i64) = sqlx::query_as(
            "SELECT coalesce(sum(state = 'open'), 0), coalesce(sum(state = 'closed'), 0)
             FROM milestones WHERE workspace_id = ? AND project_id = ?",
        )
        .bind(workspace)
        .bind(&id)
        .fetch_one(pool)
        .await?;
        let objectives: i64 =
            sqlx::query_scalar("SELECT count(*) FROM objectives WHERE project_id = ?")
                .bind(&id)
                .fetch_one(pool)
                .await?;
        let (linked, done): (i64, i64) = sqlx::query_as(
            "SELECT count(DISTINCT i.id),
                    coalesce(count(DISTINCT CASE WHEN i.status = 'done' THEN i.id END), 0)
             FROM objective_issues AS l
             JOIN objectives AS o ON o.id = l.objective_id
             JOIN issues AS i ON i.id = l.issue_id
             WHERE o.project_id = ? AND i.status != 'canceled' AND i.archived_at IS NULL",
        )
        .bind(&id)
        .fetch_one(pool)
        .await?;
        out.push(ProjectProgress {
            project_id: id,
            name,
            status,
            issues,
            milestones_open: open,
            milestones_closed: closed,
            objectives,
            objective_linked: linked,
            objective_done: done,
        });
    }
    Ok(out)
}

async fn deadlines(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
    today: &str,
) -> Result<Vec<Deadline>, AnalyticsError> {
    let horizon = add_days(today, DEADLINE_DAYS);
    Ok(sqlx::query_as(
        "SELECT * FROM (
             SELECT 'issue' AS kind, i.id AS id, i.number AS number, i.title AS title,
                    i.project_id AS project_id, p.name AS project_name,
                    i.due_date AS due_date, i.due_date < ?3 AS overdue
             FROM issues AS i LEFT JOIN projects AS p ON p.id = i.project_id
             WHERE i.workspace_id = ?1 AND i.archived_at IS NULL AND i.closed = 0
               AND i.due_date IS NOT NULL AND i.due_date <= ?4
               AND (?2 IS NULL OR i.project_id = ?2)
             UNION ALL
             SELECT 'milestone', m.id, NULL, m.title, m.project_id, p.name, m.due_date,
                    m.due_date < ?3
             FROM milestones AS m LEFT JOIN projects AS p ON p.id = m.project_id
             WHERE m.workspace_id = ?1 AND m.state = 'open'
               AND m.due_date IS NOT NULL AND m.due_date <= ?4
               AND (?2 IS NULL OR m.project_id = ?2)
         ) ORDER BY due_date, kind, number, title LIMIT ?5",
    )
    .bind(workspace)
    .bind(project)
    .bind(today)
    .bind(&horizon)
    .bind(DEADLINE_LIMIT)
    .fetch_all(pool)
    .await?)
}

async fn trend(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
    (first, last): (Date, Date),
    zone: &jiff::tz::TimeZone,
    (start_at, end_at): (&str, &str),
) -> Result<Trend, AnalyticsError> {
    let (done_total, with_time): (i64, i64) = sqlx::query_as(
        "SELECT count(*), coalesce(sum(completed_at IS NOT NULL), 0) FROM issues
         WHERE workspace_id = ?1 AND archived_at IS NULL AND status = 'done'
           AND (?2 IS NULL OR project_id = ?2)",
    )
    .bind(workspace)
    .bind(project)
    .fetch_one(pool)
    .await?;
    let stamps: Vec<String> = sqlx::query_scalar(
        "SELECT completed_at FROM issues
         WHERE workspace_id = ?1 AND archived_at IS NULL AND status = 'done'
           AND completed_at IS NOT NULL AND (?2 IS NULL OR project_id = ?2)
           AND substr(completed_at, 1, 19) >= ?3 AND substr(completed_at, 1, 19) < ?4",
    )
    .bind(workspace)
    .bind(project)
    .bind(&start_at[..19])
    .bind(&end_at[..19])
    .fetch_all(pool)
    .await?;
    let mut by_day: BTreeMap<Date, i64> = BTreeMap::new();
    for stamp in stamps {
        if let Ok(at) = stamp.parse::<jiff::Timestamp>() {
            *by_day.entry(at.to_zoned(zone.clone()).date()).or_default() += 1;
        }
    }
    let days = first.until(last).map_or(0, |span| span.get_days() as i64) + 1;
    let weekly = days > DAILY_LIMIT;
    let mut buckets = Vec::new();
    let mut start = first;
    while start <= last {
        let end = if weekly {
            let to_sunday = 7 - i64::from(start.weekday().to_monday_one_offset());
            start
                .checked_add(to_sunday.days())
                .unwrap_or(last)
                .min(last)
        } else {
            start
        };
        let completed = by_day.range(start..=end).map(|(_, count)| count).sum();
        buckets.push(TrendBucket {
            start: start.to_string(),
            end: end.to_string(),
            completed,
        });
        match end.tomorrow() {
            Ok(next) => start = next,
            Err(_) => break,
        }
    }
    Ok(Trend {
        granularity: if weekly { "week" } else { "day" }.to_owned(),
        buckets,
        done_total,
        with_time,
        without_time: done_total - with_time,
    })
}

/// Progress for the workspace, or one project, with the trend over
/// `from..=to`. Totals, projects, and deadlines are as of `today`.
pub async fn progress(
    pool: &SqlitePool,
    workspace: &str,
    from: &str,
    to: &str,
    project: Option<&str>,
    time_zone: &str,
    today: &str,
) -> Result<ProgressAnalytics, AnalyticsError> {
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
    let after = last
        .checked_add(1.day())
        .map_err(|_| AnalyticsError::InvalidDate)?;
    let span = window(&ItemRange {
        from: from.to_owned(),
        to: after.to_string(),
        time_zone: time_zone.to_owned(),
    })?;
    Ok(ProgressAnalytics {
        from: from.to_owned(),
        to: to.to_owned(),
        today: today.to_owned(),
        project_id: project.map(str::to_owned),
        totals: totals(pool, workspace, project, today).await?,
        projects: per_project(pool, workspace, project, today).await?,
        deadlines: deadlines(pool, workspace, project, today).await?,
        trend: trend(
            pool,
            workspace,
            project,
            (first, last),
            &span.zone,
            (&span.start_at, &span.end_at),
        )
        .await?,
    })
}

#[tauri::command]
pub async fn get_progress_analytics(
    instances: State<'_, DbInstances>,
    from: String,
    to: String,
    project_id: Option<String>,
    time_zone: String,
) -> Result<ProgressAnalytics, AnalyticsError> {
    let instance = pool(&instances).await?;
    let workspace = active_workspace(&instance).await?;
    progress(
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
