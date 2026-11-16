//! Archiving, restoring, and permanently deleting issues. The policy is in
//! docs/DATA_MODEL.md under "Archiving and deletion".

use super::{get, recurrence, storage_failed, Issue, IssueError, NOW};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};

/// Archives (`true`) or restores (`false`) an issue. Only `archived_at`
/// changes, so the issue keeps its ID, status, and every link. Repeating
/// the current state changes nothing.
pub async fn set_archived(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    archived: bool,
) -> Result<Issue, IssueError> {
    let updated = sqlx::query(&format!(
        "UPDATE issues SET archived_at = CASE WHEN ?1 THEN coalesce(archived_at, {NOW}) END
         WHERE id = ?2 AND workspace_id = ?3"
    ))
    .bind(archived)
    .bind(id)
    .bind(workspace)
    .execute(pool)
    .await
    .map_err(storage_failed)?
    .rows_affected();
    if updated == 0 {
        return Err(IssueError::NotFound);
    }
    get(pool, workspace, id).await
}

/// What permanently deleting an issue would remove, and what prevents it.
#[derive(Debug, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionImpact {
    /// The key the user must type to confirm, such as `ISS-12`.
    pub key: String,
    pub archived: bool,
    pub labels: i64,
    pub documents: i64,
    pub objectives: i64,
    /// Parent, blocking, and related links, counted once per pair.
    pub relationships: i64,
    /// Sub-issues block deletion.
    pub sub_issues: i64,
    /// Being the latest occurrence of an active series blocks deletion.
    pub active_series: bool,
}

impl DeletionImpact {
    /// The first reason deletion is refused, if any.
    fn blocker(&self) -> Option<IssueError> {
        if !self.archived {
            Some(IssueError::NotArchived)
        } else if self.sub_issues > 0 {
            Some(IssueError::HasSubIssues)
        } else if self.active_series {
            Some(IssueError::ActiveSeries)
        } else {
            None
        }
    }
}

const IMPACT: &str = "SELECT 'ISS-' || i.number AS key, i.archived_at IS NOT NULL AS archived,
         (SELECT count(*) FROM issue_labels WHERE issue_id = i.id) AS labels,
         (SELECT count(*) FROM issue_documents WHERE issue_id = i.id) AS documents,
         (SELECT count(*) FROM objective_issues WHERE issue_id = i.id) AS objectives,
         (SELECT count(*) FROM issue_relationships
          WHERE workspace_id = i.workspace_id AND (source_id = i.id OR target_id = i.id))
             AS relationships,
         (SELECT count(*) FROM issue_relationships
          WHERE workspace_id = i.workspace_id AND kind = 'parent' AND target_id = i.id)
             AS sub_issues,
         EXISTS (SELECT 1 FROM issue_recurrences AS r
                 WHERE r.id = i.recurrence_id AND r.stopped_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM issues AS later
                                   WHERE later.recurrence_id = r.id
                                     AND later.occurrence_index > i.occurrence_index))
             AS active_series
     FROM issues AS i WHERE i.id = ? AND i.workspace_id = ?";

pub async fn deletion_impact(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
) -> Result<DeletionImpact, IssueError> {
    sqlx::query_as(IMPACT)
        .bind(id)
        .bind(workspace)
        .fetch_optional(pool)
        .await
        .map_err(storage_failed)?
        .ok_or(IssueError::NotFound)
}

/// Permanently deletes an archived issue after `confirm_key` matches its key
/// (`ISS-12`, ignoring case and surrounding spaces). The policy is checked
/// again inside the transaction. Link rows go with the issue through their
/// `ON DELETE CASCADE` keys; no other record is deleted.
pub async fn delete(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    confirm_key: &str,
) -> Result<(), IssueError> {
    let mut transaction = pool.begin().await.map_err(storage_failed)?;
    recurrence::lock(&mut transaction, workspace, id).await?;
    let impact: DeletionImpact = sqlx::query_as(IMPACT)
        .bind(id)
        .bind(workspace)
        .fetch_one(&mut *transaction)
        .await
        .map_err(storage_failed)?;
    if !confirm_key.trim().eq_ignore_ascii_case(&impact.key) {
        return Err(IssueError::ConfirmationMismatch);
    }
    if let Some(blocker) = impact.blocker() {
        return Err(blocker);
    }
    sqlx::query("DELETE FROM issues WHERE id = ? AND workspace_id = ?")
        .bind(id)
        .bind(workspace)
        .execute(&mut *transaction)
        .await
        .map_err(storage_failed)?;
    transaction.commit().await.map_err(storage_failed)
}

#[cfg(test)]
mod tests;
