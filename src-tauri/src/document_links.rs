//! Links from issues and projects to existing documents.
//!
//! Links are separate rows keyed by stable IDs. Linking and unlinking never
//! read or change document content, and a link disappears with either end.

use crate::database::{active_workspace, pool, DatabaseError};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedDocument {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

/// A document reached through issues in a project, with those issues.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritedDocument {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub issues: Vec<LinkingIssue>,
}

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkingIssue {
    pub id: String,
    pub number: i64,
    pub title: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocuments {
    /// Linked to the project itself.
    pub direct: Vec<LinkedDocument>,
    /// Linked to the project's issues but not to the project.
    pub via_issues: Vec<InheritedDocument>,
}

#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkingProject {
    pub id: String,
    pub name: String,
}

/// Everything that links to a document, for navigating back from it.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUsage {
    pub issues: Vec<LinkingIssue>,
    pub projects: Vec<LinkingProject>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum LinkError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    /// The issue or project is not in the active workspace.
    NotFound,
    /// The document is not in the active workspace.
    DocumentNotFound,
    StorageFailed,
}

impl From<DatabaseError> for LinkError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> LinkError {
    eprintln!("Document link storage failed: {error}");
    LinkError::StorageFailed
}

/// Which side of a link: the table, its owner column, and the owner table.
#[derive(Clone, Copy)]
pub enum Owner {
    Issue,
    Project,
}

impl Owner {
    fn parts(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Issue => ("issue_documents", "issue_id", "issues"),
            Self::Project => ("project_documents", "project_id", "projects"),
        }
    }
}

async fn ensure(
    pool: &SqlitePool,
    table: &str,
    workspace: &str,
    id: &str,
) -> Result<bool, LinkError> {
    Ok(sqlx::query(&format!(
        "SELECT 1 FROM {table} WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .is_some())
}

/// Documents linked directly to an issue or project, by title.
pub async fn linked(
    pool: &SqlitePool,
    workspace: &str,
    owner: Owner,
    id: &str,
) -> Result<Vec<LinkedDocument>, LinkError> {
    let (table, column, owners) = owner.parts();
    if !ensure(pool, owners, workspace, id).await? {
        return Err(LinkError::NotFound);
    }
    sqlx::query_as(&format!(
        "SELECT d.id, d.title, d.updated_at FROM {table} AS l
         JOIN documents AS d ON d.id = l.document_id AND d.workspace_id = l.workspace_id
         WHERE l.{column} = ? AND l.workspace_id = ?
         ORDER BY d.title COLLATE NOCASE, d.id"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)
}

/// Links a document. Linking an already linked document changes nothing.
pub async fn link(
    pool: &SqlitePool,
    workspace: &str,
    owner: Owner,
    id: &str,
    document: &str,
) -> Result<Vec<LinkedDocument>, LinkError> {
    let (table, column, owners) = owner.parts();
    if !ensure(pool, owners, workspace, id).await? {
        return Err(LinkError::NotFound);
    }
    if !ensure(pool, "documents", workspace, document).await? {
        return Err(LinkError::DocumentNotFound);
    }
    sqlx::query(&format!(
        "INSERT INTO {table} ({column}, document_id, workspace_id) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING"
    ))
    .bind(id)
    .bind(document)
    .bind(workspace)
    .execute(pool)
    .await
    .map_err(storage_failed)?;
    linked(pool, workspace, owner, id).await
}

/// Removes only the link. The document and the issue or project are kept,
/// and removing a link that does not exist changes nothing.
pub async fn unlink(
    pool: &SqlitePool,
    workspace: &str,
    owner: Owner,
    id: &str,
    document: &str,
) -> Result<Vec<LinkedDocument>, LinkError> {
    let (table, column, owners) = owner.parts();
    if !ensure(pool, owners, workspace, id).await? {
        return Err(LinkError::NotFound);
    }
    sqlx::query(&format!(
        "DELETE FROM {table} WHERE {column} = ? AND document_id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(document)
    .bind(workspace)
    .execute(pool)
    .await
    .map_err(storage_failed)?;
    linked(pool, workspace, owner, id).await
}

/// A project's own documents, and documents its issues link to that the
/// project does not, each with the issues that link it.
pub async fn for_project(
    pool: &SqlitePool,
    workspace: &str,
    project: &str,
) -> Result<ProjectDocuments, LinkError> {
    let direct = linked(pool, workspace, Owner::Project, project).await?;
    let rows: Vec<(String, String, String, String, i64, String)> = sqlx::query_as(
        "SELECT d.id, d.title, d.updated_at, i.id, i.number, i.title
         FROM issue_documents AS l
         JOIN issues AS i ON i.id = l.issue_id AND i.workspace_id = l.workspace_id
         JOIN documents AS d ON d.id = l.document_id AND d.workspace_id = l.workspace_id
         WHERE l.workspace_id = ?1 AND i.project_id = ?2
           AND NOT EXISTS (SELECT 1 FROM project_documents AS p
                           WHERE p.project_id = ?2 AND p.document_id = d.id)
         ORDER BY d.title COLLATE NOCASE, d.id, i.number",
    )
    .bind(workspace)
    .bind(project)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;
    let mut via_issues: Vec<InheritedDocument> = Vec::new();
    for (id, title, updated_at, issue_id, number, issue_title) in rows {
        let issue = LinkingIssue {
            id: issue_id,
            number,
            title: issue_title,
        };
        match via_issues.last_mut() {
            Some(document) if document.id == id => document.issues.push(issue),
            _ => via_issues.push(InheritedDocument {
                id,
                title,
                updated_at,
                issues: vec![issue],
            }),
        }
    }
    Ok(ProjectDocuments { direct, via_issues })
}

/// The issues and projects that link to a document.
pub async fn usage(
    pool: &SqlitePool,
    workspace: &str,
    document: &str,
) -> Result<DocumentUsage, LinkError> {
    if !ensure(pool, "documents", workspace, document).await? {
        return Err(LinkError::DocumentNotFound);
    }
    let issues = sqlx::query_as(
        "SELECT i.id, i.number, i.title FROM issue_documents AS l
         JOIN issues AS i ON i.id = l.issue_id AND i.workspace_id = l.workspace_id
         WHERE l.document_id = ? AND l.workspace_id = ? ORDER BY i.number",
    )
    .bind(document)
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;
    let projects = sqlx::query_as(
        "SELECT p.id, p.name FROM project_documents AS l
         JOIN projects AS p ON p.id = l.project_id AND p.workspace_id = l.workspace_id
         WHERE l.document_id = ? AND l.workspace_id = ? ORDER BY p.name COLLATE NOCASE, p.id",
    )
    .bind(document)
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;
    Ok(DocumentUsage { issues, projects })
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), LinkError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn list_issue_documents(
    instances: State<'_, DbInstances>,
    issue_id: String,
) -> Result<Vec<LinkedDocument>, LinkError> {
    let (pool, workspace) = scope(&instances).await?;
    linked(&pool, &workspace, Owner::Issue, &issue_id).await
}

#[tauri::command]
pub async fn link_issue_document(
    instances: State<'_, DbInstances>,
    issue_id: String,
    document_id: String,
) -> Result<Vec<LinkedDocument>, LinkError> {
    let (pool, workspace) = scope(&instances).await?;
    link(&pool, &workspace, Owner::Issue, &issue_id, &document_id).await
}

#[tauri::command]
pub async fn unlink_issue_document(
    instances: State<'_, DbInstances>,
    issue_id: String,
    document_id: String,
) -> Result<Vec<LinkedDocument>, LinkError> {
    let (pool, workspace) = scope(&instances).await?;
    unlink(&pool, &workspace, Owner::Issue, &issue_id, &document_id).await
}

#[tauri::command]
pub async fn list_project_documents(
    instances: State<'_, DbInstances>,
    project_id: String,
) -> Result<ProjectDocuments, LinkError> {
    let (pool, workspace) = scope(&instances).await?;
    for_project(&pool, &workspace, &project_id).await
}

#[tauri::command]
pub async fn link_project_document(
    instances: State<'_, DbInstances>,
    project_id: String,
    document_id: String,
) -> Result<ProjectDocuments, LinkError> {
    let (pool, workspace) = scope(&instances).await?;
    link(&pool, &workspace, Owner::Project, &project_id, &document_id).await?;
    for_project(&pool, &workspace, &project_id).await
}

#[tauri::command]
pub async fn unlink_project_document(
    instances: State<'_, DbInstances>,
    project_id: String,
    document_id: String,
) -> Result<ProjectDocuments, LinkError> {
    let (pool, workspace) = scope(&instances).await?;
    unlink(&pool, &workspace, Owner::Project, &project_id, &document_id).await?;
    for_project(&pool, &workspace, &project_id).await
}

#[tauri::command]
pub async fn get_document_usage(
    instances: State<'_, DbInstances>,
    document_id: String,
) -> Result<DocumentUsage, LinkError> {
    let (pool, workspace) = scope(&instances).await?;
    usage(&pool, &workspace, &document_id).await
}

#[cfg(test)]
mod tests;
