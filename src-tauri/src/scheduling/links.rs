//! Links from calendar events to existing documents and projects.
//!
//! A link is a row of two IDs, so renaming or archiving either record keeps
//! it and no content is copied. Unlinking removes only the row. Deleting an
//! event, document, or project removes its links with it.

use super::{scope, SchedulingError};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;

/// A linked document or project with its current name.
#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRecord {
    pub id: String,
    pub title: String,
    /// Archived records stay linked and can still be opened.
    pub archived: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventLinks {
    pub documents: Vec<LinkedRecord>,
    pub projects: Vec<LinkedRecord>,
}

/// Which kind of record a link points at.
#[derive(Clone, Copy)]
pub enum Target {
    Document,
    Project,
}

impl Target {
    /// The link table, its target column, and the target table.
    fn parts(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Document => ("event_documents", "document_id", "documents"),
            Self::Project => ("event_projects", "project_id", "projects"),
        }
    }

    fn missing(self) -> SchedulingError {
        match self {
            Self::Document => SchedulingError::DocumentNotFound,
            Self::Project => SchedulingError::ProjectNotFound,
        }
    }
}

async fn exists(
    pool: &SqlitePool,
    table: &str,
    workspace: &str,
    id: &str,
) -> Result<bool, SchedulingError> {
    Ok(sqlx::query(&format!(
        "SELECT 1 FROM {table} WHERE id = ? AND workspace_id = ?"
    ))
    .bind(id)
    .bind(workspace)
    .fetch_optional(pool)
    .await?
    .is_some())
}

/// An event's linked documents and projects, by current name.
pub async fn links(
    pool: &SqlitePool,
    workspace: &str,
    event: &str,
) -> Result<EventLinks, SchedulingError> {
    if !exists(pool, "events", workspace, event).await? {
        return Err(SchedulingError::NotFound);
    }
    let documents = sqlx::query_as(
        "SELECT d.id, d.title, d.archived_at IS NOT NULL AS archived
         FROM event_documents AS l
         JOIN documents AS d ON d.id = l.document_id AND d.workspace_id = l.workspace_id
         WHERE l.event_id = ? AND l.workspace_id = ?
         ORDER BY d.title COLLATE NOCASE, d.id",
    )
    .bind(event)
    .bind(workspace)
    .fetch_all(pool)
    .await?;
    let projects = sqlx::query_as(
        "SELECT p.id, p.name AS title, p.status = 'archived' AS archived
         FROM event_projects AS l
         JOIN projects AS p ON p.id = l.project_id AND p.workspace_id = l.workspace_id
         WHERE l.event_id = ? AND l.workspace_id = ?
         ORDER BY p.name COLLATE NOCASE, p.id",
    )
    .bind(event)
    .bind(workspace)
    .fetch_all(pool)
    .await?;
    Ok(EventLinks {
        documents,
        projects,
    })
}

/// Links a record. Linking one that is already linked changes nothing.
pub async fn link(
    pool: &SqlitePool,
    workspace: &str,
    event: &str,
    target: Target,
    id: &str,
) -> Result<EventLinks, SchedulingError> {
    let (table, column, targets) = target.parts();
    if !exists(pool, "events", workspace, event).await? {
        return Err(SchedulingError::NotFound);
    }
    if !exists(pool, targets, workspace, id).await? {
        return Err(target.missing());
    }
    sqlx::query(&format!(
        "INSERT INTO {table} (event_id, {column}, workspace_id) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING"
    ))
    .bind(event)
    .bind(id)
    .bind(workspace)
    .execute(pool)
    .await?;
    links(pool, workspace, event).await
}

/// Removes only the link. The event and the record are kept, and removing a
/// link that does not exist changes nothing.
pub async fn unlink(
    pool: &SqlitePool,
    workspace: &str,
    event: &str,
    target: Target,
    id: &str,
) -> Result<EventLinks, SchedulingError> {
    let (table, column, _) = target.parts();
    if !exists(pool, "events", workspace, event).await? {
        return Err(SchedulingError::NotFound);
    }
    sqlx::query(&format!(
        "DELETE FROM {table} WHERE event_id = ? AND {column} = ? AND workspace_id = ?"
    ))
    .bind(event)
    .bind(id)
    .bind(workspace)
    .execute(pool)
    .await?;
    links(pool, workspace, event).await
}

macro_rules! command {
    ($name:ident, $operation:ident, $target:expr) => {
        #[tauri::command]
        pub async fn $name(
            instances: State<'_, DbInstances>,
            event_id: String,
            id: String,
        ) -> Result<EventLinks, SchedulingError> {
            let (pool, workspace) = scope(&instances).await?;
            $operation(&pool, &workspace, &event_id, $target, &id).await
        }
    };
}

command!(link_event_document, link, Target::Document);
command!(unlink_event_document, unlink, Target::Document);
command!(link_event_project, link, Target::Project);
command!(unlink_event_project, unlink, Target::Project);

#[tauri::command]
pub async fn get_event_links(
    instances: State<'_, DbInstances>,
    event_id: String,
) -> Result<EventLinks, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    links(&pool, &workspace, &event_id).await
}

#[cfg(test)]
mod tests;
