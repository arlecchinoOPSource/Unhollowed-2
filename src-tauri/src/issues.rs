use crate::database::{active_workspace, pool, DatabaseError};
use crate::documents::{is_rich_text, EMPTY_CONTENT};
use crate::projects::valid_date;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteExecutor, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

mod query;
mod recurrence;
#[cfg(test)]
pub use query::IssueFilter;
pub(crate) use query::{index_missing, search_text};
pub use query::{query, IssuePage, IssueQuery};
pub use recurrence::{add_days, recurrence_for, set_rule, Recurrence, RecurrenceInput};

const MAX_TITLE_CHARS: usize = 200;
pub(crate) const PRIORITIES: [&str; 5] = ["none", "low", "medium", "high", "urgent"];
/// Done and canceled are closed. The others are open.
pub(crate) const STATUSES: [&str; 5] = ["todo", "in_progress", "blocked", "done", "canceled"];
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/// The list form of an issue. It leaves out the description, which can be
/// large rich text.
#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub id: String,
    /// Readable per-workspace number, shown as `ISS-<number>`.
    pub number: i64,
    pub project_id: Option<String>,
    pub title: String,
    pub status: String,
    pub priority: String,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub completed_at: Option<String>,
    /// Derived from status: true for done and canceled issues.
    pub closed: bool,
    pub created_at: String,
    pub updated_at: String,
    /// At most one milestone: a workspace one or one for the issue's project.
    pub milestone_id: Option<String>,
    /// The series this issue is an occurrence of, if any.
    pub recurrence_id: Option<String>,
    /// True while the issue's series is active (not stopped).
    pub recurring: bool,
    /// IDs of the issue's labels, including archived ones.
    #[sqlx(try_from = "String")]
    pub label_ids: LabelIds,
}

/// Label IDs read from a JSON array produced by SQLite.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(transparent)]
pub struct LabelIds(pub Vec<String>);

impl TryFrom<String> for LabelIds {
    type Error = serde_json::Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        serde_json::from_str(&value).map(Self)
    }
}

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub summary: IssueSummary,
    /// Tiptap JSON, stored and returned exactly as the editor produced it.
    pub description: String,
}

/// The editable fields of an issue. Status and project have their own
/// commands so each change keeps its lifecycle rules.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueFields {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<String>,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum IssueError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    NotFound,
    InvalidTitle,
    InvalidDescription,
    InvalidPriority,
    InvalidStatus,
    InvalidDate,
    InvalidDateRange,
    /// The project does not exist in the active workspace.
    InvalidProject,
    /// A search, filter, sort, or page value is not supported.
    InvalidFilter,
    /// A label does not exist in the active workspace.
    InvalidLabel,
    /// An archived label cannot be newly assigned. Existing links remain.
    LabelArchived,
    /// The milestone is not in the workspace, or belongs to another project.
    InvalidMilestone,
    /// A closed milestone cannot gain issues. Existing links remain.
    MilestoneClosed,
    /// The repeat frequency or interval is not supported.
    InvalidRecurrence,
    /// A repeat rule is anchored on a due date, so the issue needs one.
    RecurrenceNeedsDueDate,
    StorageFailed,
}

impl From<DatabaseError> for IssueError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

pub(crate) fn storage_failed(error: sqlx::Error) -> IssueError {
    eprintln!("Issue storage failed: {error}");
    IssueError::StorageFailed
}

/// Issue fields after validation, with defaults applied.
pub(crate) struct ValidFields {
    pub title: String,
    pub description: String,
    pub priority: String,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    /// Kept in sync with title and description on every write.
    pub search_text: String,
}

impl IssueFields {
    pub(crate) fn validate(self) -> Result<ValidFields, IssueError> {
        let title = self.title.trim().to_owned();
        if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS || title.contains('\0') {
            return Err(IssueError::InvalidTitle);
        }
        let description = self.description.unwrap_or_else(|| EMPTY_CONTENT.into());
        if !is_rich_text(&description) {
            return Err(IssueError::InvalidDescription);
        }
        let priority = self.priority.unwrap_or_else(|| "none".into());
        if !PRIORITIES.contains(&priority.as_str()) {
            return Err(IssueError::InvalidPriority);
        }
        if self
            .start_date
            .iter()
            .chain(&self.due_date)
            .any(|date| !valid_date(date))
        {
            return Err(IssueError::InvalidDate);
        }
        if let (Some(start), Some(due)) = (&self.start_date, &self.due_date) {
            if start > due {
                return Err(IssueError::InvalidDateRange);
            }
        }
        Ok(ValidFields {
            search_text: search_text(&title, &description),
            title,
            description,
            priority,
            start_date: self.start_date,
            due_date: self.due_date,
        })
    }
}

/// The label IDs are read with each row, including in RETURNING clauses, so
/// every command returns an issue's current labels.
macro_rules! summary_fields {
    () => {
        "id, number, project_id, title, status, priority, start_date, due_date, \
         completed_at, closed, created_at, updated_at, milestone_id, recurrence_id, \
         EXISTS (SELECT 1 FROM issue_recurrences AS r WHERE r.id = issues.recurrence_id \
                 AND r.stopped_at IS NULL) AS recurring, \
         (SELECT json_group_array(label_id) FROM (SELECT label_id FROM issue_labels \
          WHERE issue_id = issues.id ORDER BY label_id)) AS label_ids"
    };
}
pub(crate) const SUMMARY_FIELDS: &str = summary_fields!();
pub(crate) const FIELDS: &str = concat!(summary_fields!(), ", description");

/// Fails with `InvalidProject` unless the project belongs to the workspace.
pub(crate) async fn ensure_project<'e>(
    executor: impl SqliteExecutor<'e>,
    workspace: &str,
    project: &str,
) -> Result<(), IssueError> {
    sqlx::query("SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?")
        .bind(project)
        .bind(workspace)
        .fetch_optional(executor)
        .await
        .map_err(storage_failed)?
        .map(|_| ())
        .ok_or(IssueError::InvalidProject)
}

/// Lists a workspace's issues, optionally only those in one project.
/// Every query filters by `workspace_id`, so another workspace's rows are
/// never returned.
pub async fn list(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
) -> Result<Vec<IssueSummary>, IssueError> {
    sqlx::query_as(&format!(
        "SELECT {SUMMARY_FIELDS} FROM issues
         WHERE workspace_id = ?1 AND (?2 IS NULL OR project_id = ?2)
         ORDER BY updated_at DESC, number DESC"
    ))
    .bind(workspace)
    .bind(project)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)
}

pub async fn get(pool: &SqlitePool, workspace: &str, id: &str) -> Result<Issue, IssueError> {
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM issues WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(IssueError::NotFound)
}

/// Creates an issue and gives it the workspace's next number.
///
/// The counter update and the insert share one transaction, so a failed
/// create never uses up a number and two creates never receive the same one.
pub async fn create(
    pool: &SqlitePool,
    workspace: &str,
    fields: IssueFields,
    project: Option<&str>,
) -> Result<Issue, IssueError> {
    let fields = fields.validate()?;
    let mut transaction = pool.begin().await.map_err(storage_failed)?;
    // Writing first makes this transaction take SQLite's write lock before it
    // reads anything, so concurrent creates wait for each other in turn.
    let number: i64 = sqlx::query_scalar(
        "INSERT INTO issue_counters (workspace_id, last_number) VALUES (?, 1)
         ON CONFLICT (workspace_id) DO UPDATE SET last_number = last_number + 1
         RETURNING last_number",
    )
    .bind(workspace)
    .fetch_one(&mut *transaction)
    .await
    .map_err(storage_failed)?;
    if let Some(project) = project {
        ensure_project(&mut *transaction, workspace, project).await?;
    }
    let issue = sqlx::query_as(&format!(
        "INSERT INTO issues
            (id, workspace_id, number, project_id, title, description, priority, start_date,
             due_date, search_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING {FIELDS}"
    ))
    .bind(Uuid::new_v4().to_string())
    .bind(workspace)
    .bind(number)
    .bind(project)
    .bind(fields.title)
    .bind(fields.description)
    .bind(fields.priority)
    .bind(fields.start_date)
    .bind(fields.due_date)
    .bind(fields.search_text)
    .fetch_one(&mut *transaction)
    .await
    .map_err(storage_failed)?;
    transaction.commit().await.map_err(storage_failed)?;
    Ok(issue)
}

/// Replaces the editable fields. Status and project are left unchanged.
pub async fn update(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    fields: IssueFields,
) -> Result<Issue, IssueError> {
    let fields = fields.validate()?;
    sqlx::query_as(&format!(
        "UPDATE issues SET title = ?, description = ?, priority = ?, start_date = ?, due_date = ?,
             search_text = ?, updated_at = {NOW}
         WHERE id = ? AND workspace_id = ? RETURNING {FIELDS}"
    ))
    .bind(fields.title)
    .bind(fields.description)
    .bind(fields.priority)
    .bind(fields.start_date)
    .bind(fields.due_date)
    .bind(fields.search_text)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(IssueError::NotFound)
}

/// Moves an issue to any status.
///
/// Entering done records `completed_at` once. Any other status clears it.
/// Repeating the current status changes nothing, so retries keep timestamps.
/// SQLite evaluates every right-hand side against the row before the update.
#[cfg(test)]
pub async fn set_status(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    status: &str,
) -> Result<Issue, IssueError> {
    set_status_on(pool, workspace, id, status, None).await
}

/// Like [`set_status`], and when a recurring issue enters Done or Canceled
/// it also creates the next occurrence in the same transaction. `today` is
/// the user's local date, used to skip missed occurrence dates.
pub async fn set_status_on(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    status: &str,
    today: Option<&str>,
) -> Result<Issue, IssueError> {
    if !STATUSES.contains(&status) {
        return Err(IssueError::InvalidStatus);
    }
    recurrence::valid_today(today)?;
    let mut transaction = pool.begin().await.map_err(storage_failed)?;
    recurrence::lock(&mut transaction, workspace, id).await?;
    let (was_closed,): (bool,) =
        sqlx::query_as("SELECT closed FROM issues WHERE id = ? AND workspace_id = ?")
            .bind(id)
            .bind(workspace)
            .fetch_one(&mut *transaction)
            .await
            .map_err(storage_failed)?;
    sqlx::query(&format!(
        "UPDATE issues SET
             status = ?1,
             completed_at = CASE WHEN ?1 = 'done' THEN coalesce(completed_at, {NOW}) END,
             updated_at = CASE WHEN status = ?1 THEN updated_at ELSE {NOW} END
         WHERE id = ?2 AND workspace_id = ?3"
    ))
    .bind(status)
    .bind(id)
    .bind(workspace)
    .execute(&mut *transaction)
    .await
    .map_err(storage_failed)?;
    if !was_closed && matches!(status, "done" | "canceled") {
        recurrence::advance(&mut transaction, workspace, id, today).await?;
    }
    transaction.commit().await.map_err(storage_failed)?;
    get(pool, workspace, id).await
}

/// Returns a done or canceled issue to To Do. An open issue keeps its status.
pub async fn reopen(pool: &SqlitePool, workspace: &str, id: &str) -> Result<Issue, IssueError> {
    sqlx::query_as(&format!(
        "UPDATE issues SET
             status = CASE WHEN closed THEN 'todo' ELSE status END,
             completed_at = NULL,
             updated_at = CASE WHEN closed THEN {NOW} ELSE updated_at END
         WHERE id = ? AND workspace_id = ? RETURNING {FIELDS}"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(IssueError::NotFound)
}

/// Assigns the issue to a project in the same workspace, or to the Inbox when
/// `project` is `None`. The issue keeps its ID and number.
///
/// A milestone for another project no longer applies after the move, so it is
/// cleared in the same update. Workspace milestones stay.
pub async fn set_project(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    project: Option<&str>,
) -> Result<Issue, IssueError> {
    if let Some(project) = project {
        ensure_project(pool, workspace, project).await?;
    }
    sqlx::query_as(&format!(
        "UPDATE issues SET
             project_id = ?1,
             milestone_id = CASE WHEN milestone_id IN (
                 SELECT id FROM milestones WHERE project_id IS NOT NULL AND project_id IS NOT ?1
             ) THEN NULL ELSE milestone_id END,
             updated_at = CASE WHEN project_id IS ?1 THEN updated_at ELSE {NOW} END
         WHERE id = ?2 AND workspace_id = ?3 RETURNING {FIELDS}"
    ))
    .bind(project)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(IssueError::NotFound)
}

/// Reschedules an issue by setting or clearing only its due date.
///
/// Everything else, including the ID, number, description, status, and links,
/// is unchanged. The new date must be on or after any start date. Repeating
/// the current date changes nothing.
pub async fn set_due_date(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    due_date: Option<&str>,
) -> Result<Issue, IssueError> {
    if due_date.is_some_and(|date| !valid_date(date)) {
        return Err(IssueError::InvalidDate);
    }
    let start: Option<(Option<String>,)> =
        sqlx::query_as("SELECT start_date FROM issues WHERE id = ? AND workspace_id = ?")
            .bind(id)
            .bind(workspace)
            .fetch_optional(pool)
            .await
            .map_err(storage_failed)?;
    let Some((start,)) = start else {
        return Err(IssueError::NotFound);
    };
    if let (Some(start), Some(due)) = (start.as_deref(), due_date) {
        if start > due {
            return Err(IssueError::InvalidDateRange);
        }
    }
    sqlx::query_as(&format!(
        "UPDATE issues SET
             due_date = ?1,
             updated_at = CASE WHEN due_date IS ?1 THEN updated_at ELSE {NOW} END
         WHERE id = ?2 AND workspace_id = ?3 RETURNING {FIELDS}"
    ))
    .bind(due_date)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(IssueError::NotFound)
}

/// Sets or clears the issue's milestone.
///
/// The milestone must be in the workspace and be a workspace milestone or one
/// for the issue's project. Closed milestones cannot gain issues, but an issue
/// already on one keeps it. Repeating the current milestone changes nothing.
pub async fn set_milestone(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    milestone: Option<&str>,
) -> Result<Issue, IssueError> {
    if let Some(milestone) = milestone {
        let found: Option<(bool, bool, bool)> = sqlx::query_as(
            "SELECT i.id IS NOT NULL,
                    m.project_id IS NULL OR m.project_id IS i.project_id,
                    m.state = 'closed' AND i.milestone_id IS NOT m.id
             FROM milestones AS m
             LEFT JOIN issues AS i ON i.id = ? AND i.workspace_id = m.workspace_id
             WHERE m.id = ? AND m.workspace_id = ?",
        )
        .bind(id)
        .bind(milestone)
        .bind(workspace)
        .fetch_optional(pool)
        .await
        .map_err(storage_failed)?;
        match found {
            None => return Err(IssueError::InvalidMilestone),
            Some((false, _, _)) => return Err(IssueError::NotFound),
            Some((_, false, _)) => return Err(IssueError::InvalidMilestone),
            Some((_, _, true)) => return Err(IssueError::MilestoneClosed),
            Some(_) => {}
        }
    }
    sqlx::query_as(&format!(
        "UPDATE issues SET
             milestone_id = ?1,
             updated_at = CASE WHEN milestone_id IS ?1 THEN updated_at ELSE {NOW} END
         WHERE id = ?2 AND workspace_id = ?3 RETURNING {FIELDS}"
    ))
    .bind(milestone)
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .ok_or(IssueError::NotFound)
}

const MAX_LABELS_PER_ISSUE: usize = 50;

/// Replaces an issue's labels with `label_ids`.
///
/// Every label must belong to the workspace. An archived label can stay on an
/// issue that already has it, and can be removed, but cannot be newly added.
/// The issue's `updated_at` changes only when its labels change.
pub async fn set_labels(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    label_ids: Vec<String>,
) -> Result<Issue, IssueError> {
    let mut wanted = label_ids;
    wanted.sort();
    wanted.dedup();
    if wanted.len() > MAX_LABELS_PER_ISSUE {
        return Err(IssueError::InvalidLabel);
    }
    let mut transaction = pool.begin().await.map_err(storage_failed)?;
    // Removing first takes SQLite's write lock before any read.
    let mut remove = sqlx::QueryBuilder::new("DELETE FROM issue_labels WHERE issue_id = ");
    remove
        .push_bind(id)
        .push(" AND workspace_id = ")
        .push_bind(workspace);
    if !wanted.is_empty() {
        remove.push(" AND label_id NOT IN (");
        let mut list = remove.separated(", ");
        for label in &wanted {
            list.push_bind(label);
        }
        list.push_unseparated(")");
    }
    let mut changed = remove
        .build()
        .execute(&mut *transaction)
        .await
        .map_err(storage_failed)?
        .rows_affected()
        > 0;
    sqlx::query("SELECT 1 FROM issues WHERE id = ? AND workspace_id = ?")
        .bind(id)
        .bind(workspace)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(storage_failed)?
        .ok_or(IssueError::NotFound)?;
    for label in &wanted {
        let found: Option<(bool, bool)> = sqlx::query_as(
            "SELECT archived_at IS NOT NULL,
                    EXISTS (SELECT 1 FROM issue_labels WHERE issue_id = ? AND label_id = labels.id)
             FROM labels WHERE id = ? AND workspace_id = ?",
        )
        .bind(id)
        .bind(label)
        .bind(workspace)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(storage_failed)?;
        match found {
            None => return Err(IssueError::InvalidLabel),
            Some((_, true)) => {}
            Some((true, false)) => return Err(IssueError::LabelArchived),
            Some((false, false)) => {
                sqlx::query(
                    "INSERT INTO issue_labels (issue_id, label_id, workspace_id) VALUES (?, ?, ?)",
                )
                .bind(id)
                .bind(label)
                .bind(workspace)
                .execute(&mut *transaction)
                .await
                .map_err(storage_failed)?;
                changed = true;
            }
        }
    }
    if changed {
        sqlx::query(&format!(
            "UPDATE issues SET updated_at = {NOW} WHERE id = ? AND workspace_id = ?"
        ))
        .bind(id)
        .bind(workspace)
        .execute(&mut *transaction)
        .await
        .map_err(storage_failed)?;
    }
    transaction.commit().await.map_err(storage_failed)?;
    get(pool, workspace, id).await
}

/// The open database and the active workspace that every command is scoped to.
/// The webview never supplies a workspace ID.
async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), IssueError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn list_issues(
    instances: State<'_, DbInstances>,
    project_id: Option<String>,
) -> Result<Vec<IssueSummary>, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    list(&pool, &workspace, project_id.as_deref()).await
}

/// Searches, filters, sorts, and pages the active workspace's issues.
#[tauri::command]
pub async fn query_issues(
    instances: State<'_, DbInstances>,
    query: IssueQuery,
) -> Result<IssuePage, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    self::query(&pool, &workspace, query).await
}

#[tauri::command]
pub async fn set_issue_due_date(
    instances: State<'_, DbInstances>,
    id: String,
    due_date: Option<String>,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    set_due_date(&pool, &workspace, &id, due_date.as_deref()).await
}

#[tauri::command]
pub async fn set_issue_milestone(
    instances: State<'_, DbInstances>,
    id: String,
    milestone_id: Option<String>,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    set_milestone(&pool, &workspace, &id, milestone_id.as_deref()).await
}

#[tauri::command]
pub async fn set_issue_labels(
    instances: State<'_, DbInstances>,
    id: String,
    label_ids: Vec<String>,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    set_labels(&pool, &workspace, &id, label_ids).await
}

#[tauri::command]
pub async fn get_issue(instances: State<'_, DbInstances>, id: String) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    get(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn create_issue(
    instances: State<'_, DbInstances>,
    input: IssueFields,
    project_id: Option<String>,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    create(&pool, &workspace, input, project_id.as_deref()).await
}

#[tauri::command]
pub async fn update_issue(
    instances: State<'_, DbInstances>,
    id: String,
    input: IssueFields,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    update(&pool, &workspace, &id, input).await
}

#[tauri::command]
pub async fn change_issue_status(
    instances: State<'_, DbInstances>,
    id: String,
    status: String,
    today: Option<String>,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    set_status_on(&pool, &workspace, &id, &status, today.as_deref()).await
}

#[tauri::command]
pub async fn set_issue_recurrence(
    instances: State<'_, DbInstances>,
    id: String,
    rule: Option<RecurrenceInput>,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    set_rule(&pool, &workspace, &id, rule).await
}

#[tauri::command]
pub async fn get_issue_recurrence(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Option<Recurrence>, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    recurrence_for(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn complete_issue(
    instances: State<'_, DbInstances>,
    id: String,
    today: Option<String>,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    set_status_on(&pool, &workspace, &id, "done", today.as_deref()).await
}

#[tauri::command]
pub async fn cancel_issue(
    instances: State<'_, DbInstances>,
    id: String,
    today: Option<String>,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    set_status_on(&pool, &workspace, &id, "canceled", today.as_deref()).await
}

#[tauri::command]
pub async fn reopen_issue(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    reopen(&pool, &workspace, &id).await
}

#[tauri::command]
pub async fn set_issue_project(
    instances: State<'_, DbInstances>,
    id: String,
    project_id: Option<String>,
) -> Result<Issue, IssueError> {
    let (pool, workspace) = scope(&instances).await?;
    set_project(&pool, &workspace, &id, project_id.as_deref()).await
}

#[cfg(test)]
mod tests;
