//! Project overview: aggregates over a project's existing issues and
//! milestones. Nothing here is stored; every number is computed on read.
//!
//! Denominators and zero-data rules (also in docs/DATA_MODEL.md):
//! - `completion` is done ÷ (all issues − canceled). Canceled work is neither
//!   done nor outstanding. With no non-canceled issues it is `None`, shown as
//!   "No issues yet" rather than 0% or 100%.
//! - Overdue and upcoming use the planning rules of Today and Upcoming: open
//!   issues only, by local due date, where overdue is before `today` and
//!   upcoming runs from `today` through the next 6 days, matching the
//!   list's "Due in the next 7 days" filter so the numbers link to it.
//! - Milestone progress uses the milestone rules (completed ÷ open +
//!   completed), for the project's own milestones.

use crate::database::{active_workspace, pool, DatabaseError};
use crate::issues::{IssueSummary, SUMMARY_FIELDS};
use crate::milestones::Milestone;
use crate::projects::{valid_date, Project};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;

/// How many issues each short list shows.
const LIST_LIMIT: i64 = 5;
const ACTIVITY_LIMIT: i64 = 10;
/// Upcoming covers today and the following 6 days, like the list's
/// "Due in the next 7 days" filter.
const UPCOMING_DAYS: i64 = 6;

#[derive(Debug, Default, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCounts {
    pub todo: i64,
    pub in_progress: i64,
    pub blocked: i64,
    pub done: i64,
    pub canceled: i64,
}

/// One observable change, labeled by the timestamp it comes from. There is
/// no change log, so `updated` means the issue's last change of any kind.
#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// `created`, `completed`, or `updated`.
    pub kind: String,
    pub at: String,
    pub issue_id: String,
    pub number: i64,
    pub title: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverview {
    pub project: Project,
    pub total: i64,
    pub open: i64,
    pub closed: i64,
    pub statuses: StatusCounts,
    /// Done ÷ (total − canceled), or `None` when that is zero.
    pub completion: Option<f64>,
    pub overdue_count: i64,
    /// The most overdue open issues first.
    pub overdue: Vec<IssueSummary>,
    pub upcoming_count: i64,
    /// Open issues due from today through the next 6 days, soonest first.
    pub upcoming: Vec<IssueSummary>,
    pub undated_open: i64,
    pub milestones: Vec<Milestone>,
    pub activity: Vec<Activity>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum OverviewError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    NotFound,
    InvalidDate,
    StorageFailed,
}

impl From<DatabaseError> for OverviewError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> OverviewError {
    eprintln!("Project overview failed: {error}");
    OverviewError::StorageFailed
}

/// The local date `days` after `date`, using the recurrence calendar math.
fn add_days(date: &str, days: i64) -> String {
    crate::issues::add_days(date, days)
}

/// Open issues due before today (?3).
const OVERDUE: &str = "due_date < ?3";
/// Open issues due from today (?3) through the horizon (?4).
const UPCOMING: &str = "due_date >= ?3 AND due_date <= ?4";

/// Bound parameters shared by the overdue and upcoming queries.
struct Scope<'a> {
    pool: &'a SqlitePool,
    workspace: &'a str,
    project: &'a str,
    today: &'a str,
    horizon: &'a str,
}

impl Scope<'_> {
    async fn count(&self, condition: &str) -> Result<i64, OverviewError> {
        sqlx::query_scalar(&format!(
            "SELECT count(*) FROM issues
             WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL AND closed = 0 AND {condition}"
        ))
        .bind(self.workspace)
        .bind(self.project)
        .bind(self.today)
        .bind(self.horizon)
        .fetch_one(self.pool)
        .await
        .map_err(storage_failed)
    }

    async fn list(&self, condition: &str) -> Result<Vec<IssueSummary>, OverviewError> {
        sqlx::query_as(&format!(
            "SELECT {SUMMARY_FIELDS} FROM issues
             WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL AND closed = 0 AND {condition}
             ORDER BY due_date, number LIMIT ?5"
        ))
        .bind(self.workspace)
        .bind(self.project)
        .bind(self.today)
        .bind(self.horizon)
        .bind(LIST_LIMIT)
        .fetch_all(self.pool)
        .await
        .map_err(storage_failed)
    }
}

pub async fn overview(
    pool: &SqlitePool,
    workspace: &str,
    project_id: &str,
    today: &str,
) -> Result<ProjectOverview, OverviewError> {
    if !valid_date(today) {
        return Err(OverviewError::InvalidDate);
    }
    let project = crate::projects::get(pool, workspace, project_id)
        .await
        .map_err(|_| OverviewError::NotFound)?;
    let statuses: StatusCounts = sqlx::query_as(
        "SELECT coalesce(sum(status = 'todo'), 0) AS todo,
                coalesce(sum(status = 'in_progress'), 0) AS in_progress,
                coalesce(sum(status = 'blocked'), 0) AS blocked,
                coalesce(sum(status = 'done'), 0) AS done,
                coalesce(sum(status = 'canceled'), 0) AS canceled
         FROM issues WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL",
    )
    .bind(workspace)
    .bind(project_id)
    .fetch_one(pool)
    .await
    .map_err(storage_failed)?;
    let open = statuses.todo + statuses.in_progress + statuses.blocked;
    let closed = statuses.done + statuses.canceled;
    let total = open + closed;
    let counted = total - statuses.canceled;
    let completion = (counted > 0).then(|| statuses.done as f64 / counted as f64);

    let horizon = add_days(today, UPCOMING_DAYS);
    let scope = Scope {
        pool,
        workspace,
        project: project_id,
        today,
        horizon: &horizon,
    };
    let overdue_count = scope.count(OVERDUE).await?;
    let upcoming_count = scope.count(UPCOMING).await?;
    let overdue = scope.list(OVERDUE).await?;
    let upcoming = scope.list(UPCOMING).await?;
    let undated_open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issues
         WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL AND closed = 0 AND due_date IS NULL",
    )
    .bind(workspace)
    .bind(project_id)
    .fetch_one(pool)
    .await
    .map_err(storage_failed)?;

    let milestones = crate::milestones::list(pool, workspace)
        .await
        .map_err(|_| OverviewError::StorageFailed)?
        .into_iter()
        .filter(|milestone| milestone.project_id.as_deref() == Some(project_id))
        .collect();

    // Created and completed come from their own timestamps. A later
    // updated_at is reported as "updated" unless it is the completion.
    let activity = sqlx::query_as(
        "SELECT kind, at, issue_id, number, title FROM (
             SELECT 'created' AS kind, created_at AS at, id AS issue_id, number, title
             FROM issues WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
             UNION ALL
             SELECT 'completed', completed_at, id, number, title
             FROM issues WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
               AND completed_at IS NOT NULL
             UNION ALL
             SELECT 'updated', updated_at, id, number, title
             FROM issues WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
               AND updated_at > created_at
               AND updated_at IS NOT completed_at
         )
         ORDER BY at DESC, number DESC LIMIT ?3",
    )
    .bind(workspace)
    .bind(project_id)
    .bind(ACTIVITY_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;

    Ok(ProjectOverview {
        project,
        total,
        open,
        closed,
        statuses,
        completion,
        overdue_count,
        overdue,
        upcoming_count,
        upcoming,
        undated_open,
        milestones,
        activity,
    })
}

#[tauri::command]
pub async fn get_project_overview(
    instances: State<'_, DbInstances>,
    project_id: String,
    today: String,
) -> Result<ProjectOverview, OverviewError> {
    let pool = pool(&instances).await?;
    let workspace = active_workspace(&pool).await?;
    overview(&pool, &workspace.id, &project_id, &today).await
}

#[cfg(test)]
mod tests;
