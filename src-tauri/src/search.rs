//! Workspace-wide search across projects, issues, and milestones.
//!
//! Matching is a literal, Unicode case-insensitive substring, like issue
//! search. Issues use their stored `search_text` (title and description).
//! Projects and milestones are few per workspace, so their rows are read
//! through the workspace index and matched in Rust, where lowercasing
//! follows full Unicode rules (SQLite's `lower()` only folds ASCII).
//! Every query is scoped to the active workspace, and each group is capped.

use crate::database::{active_workspace, pool, DatabaseError};
use crate::issues::{index_missing, IssueSummary, SUMMARY_FIELDS};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;

/// Results shown per group. Totals report how many matched in all.
pub const GROUP_LIMIT: usize = 8;
const MAX_TEXT_CHARS: usize = 200;

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHit {
    pub id: String,
    pub name: String,
    pub status: String,
}

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneHit {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub closed: bool,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub projects: Vec<ProjectHit>,
    pub project_total: usize,
    pub issues: Vec<IssueSummary>,
    pub issue_total: i64,
    pub milestones: Vec<MilestoneHit>,
    pub milestone_total: usize,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum SearchError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    StorageFailed,
}

impl From<DatabaseError> for SearchError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> SearchError {
    eprintln!("Workspace search failed: {error}");
    SearchError::StorageFailed
}

/// The issue number in `ISS-12`, `#12`, or `12`, if the text is one.
fn issue_number(text: &str) -> Option<i64> {
    let digits = text
        .strip_prefix("iss-")
        .or_else(|| text.strip_prefix('#'))
        .unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Ranks a name match: 0 for a prefix, 1 for elsewhere in the name, 2 for a
/// match only in other text, or `None` for no match.
fn rank(name: &str, other: Option<&str>, text: &str) -> Option<u8> {
    let name = name.to_lowercase();
    if name.starts_with(text) {
        Some(0)
    } else if name.contains(text) {
        Some(1)
    } else if other.is_some_and(|other| other.to_lowercase().contains(text)) {
        Some(2)
    } else {
        None
    }
}

/// Searches the workspace. Empty or overly long text returns no results.
pub async fn search(
    pool: &SqlitePool,
    workspace: &str,
    text: &str,
) -> Result<SearchResults, SearchError> {
    let text = text.trim().to_lowercase();
    if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS || text.contains('\0') {
        return Ok(SearchResults::default());
    }
    let number = issue_number(&text);

    // Projects: prefix matches first, then other name matches, then
    // description matches; active projects before archived ones.
    let rows: Vec<(String, String, Option<String>, String)> =
        sqlx::query_as("SELECT id, name, description, status FROM projects WHERE workspace_id = ?")
            .bind(workspace)
            .fetch_all(pool)
            .await
            .map_err(storage_failed)?;
    let mut projects: Vec<_> = rows
        .into_iter()
        .filter_map(|(id, name, description, status)| {
            let rank = rank(&name, description.as_deref(), &text)?;
            Some((
                rank,
                status == "archived",
                name.to_lowercase(),
                ProjectHit { id, name, status },
            ))
        })
        .collect();
    projects.sort_by(|a, b| (a.0, a.1, &a.2, &a.3.id).cmp(&(b.0, b.1, &b.2, &b.3.id)));
    let project_total = projects.len();

    // Issues: an exact number match first, then open before closed, then the
    // most recently updated.
    index_missing(pool, workspace)
        .await
        .map_err(|_| SearchError::StorageFailed)?;
    let issue_total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issues
         WHERE workspace_id = ?1 AND archived_at IS NULL
           AND (instr(search_text, ?2) > 0 OR number IS ?3)",
    )
    .bind(workspace)
    .bind(&text)
    .bind(number)
    .fetch_one(pool)
    .await
    .map_err(storage_failed)?;
    let issues = sqlx::query_as(&format!(
        "SELECT {SUMMARY_FIELDS} FROM issues
         WHERE workspace_id = ?1 AND archived_at IS NULL
           AND (instr(search_text, ?2) > 0 OR number IS ?3)
         ORDER BY number IS ?3 DESC, closed, updated_at DESC, number DESC LIMIT ?4"
    ))
    .bind(workspace)
    .bind(&text)
    .bind(number)
    .bind(GROUP_LIMIT as i64)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;

    // Milestones: open before closed, then by match rank and title.
    let rows: Vec<(
        String,
        String,
        Option<String>,
        Option<String>,
        bool,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT m.id, m.title, m.description, m.project_id, m.state = 'closed', p.name
             FROM milestones AS m LEFT JOIN projects AS p ON p.id = m.project_id
             WHERE m.workspace_id = ?",
    )
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;
    let mut milestones: Vec<_> = rows
        .into_iter()
        .filter_map(
            |(id, title, description, project_id, closed, project_name)| {
                let rank = rank(&title, description.as_deref(), &text)?;
                Some((
                    closed,
                    rank,
                    title.to_lowercase(),
                    MilestoneHit {
                        id,
                        title,
                        project_id,
                        project_name,
                        closed,
                    },
                ))
            },
        )
        .collect();
    milestones.sort_by(|a, b| (a.0, a.1, &a.2, &a.3.id).cmp(&(b.0, b.1, &b.2, &b.3.id)));
    let milestone_total = milestones.len();

    Ok(SearchResults {
        projects: projects
            .into_iter()
            .take(GROUP_LIMIT)
            .map(|(_, _, _, hit)| hit)
            .collect(),
        project_total,
        issues,
        issue_total,
        milestones: milestones
            .into_iter()
            .take(GROUP_LIMIT)
            .map(|(_, _, _, hit)| hit)
            .collect(),
        milestone_total,
    })
}

#[tauri::command]
pub async fn search_workspace(
    instances: State<'_, DbInstances>,
    text: String,
) -> Result<SearchResults, SearchError> {
    let pool = pool(&instances).await?;
    let workspace = active_workspace(&pool).await?;
    search(&pool, &workspace.id, &text).await
}

#[cfg(test)]
mod tests;
