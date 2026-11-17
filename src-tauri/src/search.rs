//! Workspace-wide search across projects, issues, milestones, and documents.
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

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentHit {
    pub id: String,
    pub title: String,
    pub preview: String,
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
    pub documents: Vec<DocumentHit>,
    pub document_total: i64,
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

async fn document_hits(
    pool: &SqlitePool,
    workspace: &str,
    text: &str,
) -> Result<(Vec<DocumentHit>, i64), SearchError> {
    let terms = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{token}\"*"))
        .collect::<Vec<_>>()
        .join(" AND ");
    if terms.is_empty() {
        return Ok((Vec::new(), 0));
    }
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM document_index
         WHERE document_index MATCH ('workspace_key:' || hex(?1) || ' AND {title body}:(' || ?2 || ')')",
    )
    .bind(workspace).bind(&terms)
    .fetch_one(pool).await.map_err(storage_failed)?;
    let documents = sqlx::query_as(
        "SELECT document_id AS id, title,
                snippet(document_index, 3, '', '', '…', 12) AS preview
         FROM document_index
         WHERE document_index MATCH ('workspace_key:' || hex(?1) || ' AND {title body}:(' || ?2 || ')')
         ORDER BY bm25(document_index, 0, 0, 8, 1), title, id LIMIT ?3",
    )
    .bind(workspace).bind(terms).bind(GROUP_LIMIT as i64)
    .fetch_all(pool).await.map_err(storage_failed)?;
    Ok((documents, total))
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

    let (documents, document_total) = document_hits(pool, workspace, &text).await?;
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
        documents,
        document_total,
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

#[cfg(test)]
mod document_tests {
    use super::document_hits;
    use crate::documents::{create, update};
    use crate::test_support::{
        add_workspace, memory_pool, migrator, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
    };

    #[test]
    fn indexes_legacy_content_and_tracks_edits_archives_and_workspace_ownership() {
        tauri::async_runtime::block_on(async {
            let db = memory_pool().await;
            migrator(18).await.run(&db).await.unwrap();
            add_workspace(&db, OTHER_WORKSPACE, "Other").await;
            let old = create(&db, DEFAULT_WORKSPACE, Some("Journal"))
                .await
                .unwrap();
            let secret = create(&db, OTHER_WORKSPACE, Some("Telescope records"))
                .await
                .unwrap();
            let body = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Observing through the télescope."}]}]}"#;
            update(&db, DEFAULT_WORKSPACE, &old.id, "Journal", body)
                .await
                .unwrap();
            migrator(19).await.run(&db).await.unwrap();
            let (hits, total) = document_hits(&db, DEFAULT_WORKSPACE, "telesc")
                .await
                .unwrap();
            assert_eq!(total, 1);
            assert_eq!(hits[0].id, old.id);
            assert!(hits[0].preview.contains("télescope"));
            let (hits, total) = document_hits(&db, OTHER_WORKSPACE, "telescope")
                .await
                .unwrap();
            assert_eq!(total, 1);
            assert_eq!(hits[0].id, secret.id);
            sqlx::query("UPDATE documents SET archived_at = 'archived' WHERE id = ?")
                .bind(&old.id)
                .execute(&db)
                .await
                .unwrap();
            assert_eq!(
                document_hits(&db, DEFAULT_WORKSPACE, "telescope")
                    .await
                    .unwrap()
                    .1,
                0
            );
            sqlx::query("UPDATE documents SET archived_at = NULL WHERE id = ?")
                .bind(&old.id)
                .execute(&db)
                .await
                .unwrap();
            assert_eq!(
                document_hits(&db, DEFAULT_WORKSPACE, "telescope")
                    .await
                    .unwrap()
                    .1,
                1
            );
            update(&db, DEFAULT_WORKSPACE, &old.id, "Observatory", &old.content)
                .await
                .unwrap();
            assert_eq!(
                document_hits(&db, DEFAULT_WORKSPACE, "telescope")
                    .await
                    .unwrap()
                    .1,
                0
            );
            assert_eq!(
                document_hits(&db, DEFAULT_WORKSPACE, "observatory")
                    .await
                    .unwrap()
                    .0[0]
                    .id,
                old.id
            );
        });
    }
}
