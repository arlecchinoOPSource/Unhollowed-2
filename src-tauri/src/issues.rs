use crate::database::DatabaseError;
use crate::documents::{is_rich_text, EMPTY_CONTENT};
use crate::projects::valid_date;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteExecutor, SqlitePool};
use uuid::Uuid;

const MAX_TITLE_CHARS: usize = 200;
const PRIORITIES: [&str; 5] = ["none", "low", "medium", "high", "urgent"];

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
            title,
            description,
            priority,
            start_date: self.start_date,
            due_date: self.due_date,
        })
    }
}

pub(crate) const SUMMARY_FIELDS: &str = "id, number, project_id, title, status, priority, \
     start_date, due_date, completed_at, closed, created_at, updated_at";
pub(crate) const FIELDS: &str = "id, number, project_id, title, status, priority, \
     start_date, due_date, completed_at, closed, created_at, updated_at, description";

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
            (id, workspace_id, number, project_id, title, description, priority, start_date, due_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING {FIELDS}"
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
    .fetch_one(&mut *transaction)
    .await
    .map_err(storage_failed)?;
    transaction.commit().await.map_err(storage_failed)?;
    Ok(issue)
}

#[cfg(test)]
mod tests;
