use crate::database::{active_workspace, pool, DatabaseError};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum RelationError {
    WorkspaceUnavailable,
    NotFound,
    SelfLink,
    Cycle,
    Duplicate,
    AlreadyHasParent,
    StorageFailed,
}

impl From<DatabaseError> for RelationError {
    fn from(_: DatabaseError) -> Self {
        Self::WorkspaceUnavailable
    }
}

impl From<sqlx::Error> for RelationError {
    fn from(error: sqlx::Error) -> Self {
        eprintln!("Issue relationship storage failed: {error}");
        Self::StorageFailed
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    Parent,
    Child,
    Blocks,
    BlockedBy,
    Related,
}

impl RelationKind {
    fn edge(self, source: &str, target: &str) -> (String, String, &'static str) {
        let (left, right, kind) = match self {
            Self::Parent => (source, target, "parent"),
            Self::Child => (target, source, "parent"),
            Self::Blocks => (source, target, "blocks"),
            Self::BlockedBy => (target, source, "blocks"),
            Self::Related if source > target => (target, source, "related"),
            Self::Related => (source, target, "related"),
        };
        (left.to_owned(), right.to_owned(), kind)
    }
}

#[derive(FromRow, Serialize)]
pub struct Relation {
    id: String,
    number: i64,
    title: String,
    status: String,
    kind: String,
}

async fn list(
    db: &SqlitePool,
    workspace: &str,
    issue: &str,
) -> Result<Vec<Relation>, RelationError> {
    Ok(sqlx::query_as(
        "SELECT i.id, i.number, i.title, i.status,
           CASE
             WHEN r.kind = 'related' THEN 'related'
             WHEN r.kind = 'parent' AND r.source_id = ?2 THEN 'parent'
             WHEN r.kind = 'parent' THEN 'child'
             WHEN r.source_id = ?2 THEN 'blocks'
             ELSE 'blocked_by'
           END AS kind
         FROM issue_relationships r JOIN issues i ON i.workspace_id = r.workspace_id
           AND i.id = CASE WHEN r.source_id = ?2 THEN r.target_id ELSE r.source_id END
         WHERE r.workspace_id = ?1 AND (r.source_id = ?2 OR r.target_id = ?2)
         ORDER BY kind, i.number",
    )
    .bind(workspace)
    .bind(issue)
    .fetch_all(db)
    .await?)
}

pub(crate) async fn add(
    db: &SqlitePool,
    workspace: &str,
    issue: &str,
    other: &str,
    kind: RelationKind,
) -> Result<(), RelationError> {
    if issue == other {
        return Err(RelationError::SelfLink);
    }
    let (source, target, kind) = kind.edge(issue, other);
    // Acquire the writer lock before reading the graph. Competing inserts
    // cannot both validate against the same pre-insert snapshot.
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let endpoints: i64 =
        sqlx::query_scalar("SELECT count(*) FROM issues WHERE workspace_id = ? AND id IN (?, ?)")
            .bind(workspace)
            .bind(&source)
            .bind(&target)
            .fetch_one(&mut *tx)
            .await?;
    if endpoints != 2 {
        return Err(RelationError::NotFound);
    }
    let duplicate: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM issue_relationships WHERE workspace_id = ? AND source_id = ? AND target_id = ? AND kind = ?)")
        .bind(workspace).bind(&source).bind(&target).bind(kind).fetch_one(&mut *tx).await?;
    if duplicate {
        return Err(RelationError::Duplicate);
    }
    if kind == "parent" {
        let has_parent: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM issue_relationships WHERE workspace_id = ? AND source_id = ? AND kind = 'parent')")
            .bind(workspace).bind(&source).fetch_one(&mut *tx).await?;
        if has_parent {
            return Err(RelationError::AlreadyHasParent);
        }
    }
    if kind != "related" {
        let cycle: bool = sqlx::query_scalar(
            "WITH RECURSIVE reachable (id) AS (
                SELECT ?3
                UNION
                SELECT r.target_id FROM reachable v JOIN issue_relationships r ON r.source_id = v.id
                WHERE r.workspace_id = ?1 AND r.kind = ?2
             ) SELECT EXISTS (SELECT 1 FROM reachable WHERE id = ?4)",
        )
        .bind(workspace)
        .bind(kind)
        .bind(&target)
        .bind(&source)
        .fetch_one(&mut *tx)
        .await?;
        if cycle {
            return Err(RelationError::Cycle);
        }
    }
    sqlx::query("INSERT INTO issue_relationships (workspace_id, source_id, target_id, kind) VALUES (?, ?, ?, ?)")
        .bind(workspace).bind(source).bind(target).bind(kind).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn remove(
    db: &SqlitePool,
    workspace: &str,
    issue: &str,
    other: &str,
    kind: RelationKind,
) -> Result<(), RelationError> {
    let (source, target, kind) = kind.edge(issue, other);
    sqlx::query("DELETE FROM issue_relationships WHERE workspace_id = ? AND source_id = ? AND target_id = ? AND kind = ?")
        .bind(workspace).bind(source).bind(target).bind(kind).execute(db).await?;
    Ok(())
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), RelationError> {
    let db = pool(instances).await?;
    let workspace = active_workspace(&db).await?;
    Ok((db, workspace.id))
}

#[tauri::command]
pub async fn list_issue_relationships(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Vec<Relation>, RelationError> {
    let (db, workspace) = scope(&instances).await?;
    list(&db, &workspace, &id).await
}

#[tauri::command]
pub async fn add_issue_relationship(
    instances: State<'_, DbInstances>,
    id: String,
    other_id: String,
    kind: RelationKind,
) -> Result<(), RelationError> {
    let (db, workspace) = scope(&instances).await?;
    add(&db, &workspace, &id, &other_id, kind).await
}

#[tauri::command]
pub async fn remove_issue_relationship(
    instances: State<'_, DbInstances>,
    id: String,
    other_id: String,
    kind: RelationKind,
) -> Result<(), RelationError> {
    let (db, workspace) = scope(&instances).await?;
    remove(&db, &workspace, &id, &other_id, kind).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        add_issue, add_issue_before_upgrade, add_workspace, migrated_pool, migrator, TempDatabase,
        DEFAULT_WORKSPACE, OTHER_WORKSPACE,
    };

    #[test]
    fn rejects_bad_links_and_preserves_closed_issue_navigation() {
        tauri::async_runtime::block_on(async {
            let db = migrated_pool().await;
            let workspace = DEFAULT_WORKSPACE;
            add_workspace(&db, OTHER_WORKSPACE, "Other").await;
            let a = add_issue(&db, workspace, None).await;
            let b = add_issue(&db, workspace, None).await;
            let c = add_issue(&db, workspace, None).await;
            let outside = add_issue(&db, OTHER_WORKSPACE, None).await;

            assert_eq!(
                add(&db, workspace, &a, &outside, RelationKind::Related).await,
                Err(RelationError::NotFound)
            );
            assert_eq!(
                add(&db, workspace, &a, &a, RelationKind::Related).await,
                Err(RelationError::SelfLink)
            );
            add(&db, workspace, &a, &b, RelationKind::Related)
                .await
                .unwrap();
            assert_eq!(
                add(&db, workspace, &b, &a, RelationKind::Related).await,
                Err(RelationError::Duplicate)
            );
            assert_eq!(list(&db, workspace, &b).await.unwrap()[0].id, a);
            remove(&db, workspace, &b, &a, RelationKind::Related)
                .await
                .unwrap();
            assert!(list(&db, workspace, &b).await.unwrap().is_empty());

            for kind in [RelationKind::Parent, RelationKind::Blocks] {
                add(&db, workspace, &a, &b, kind).await.unwrap();
                assert_eq!(
                    add(&db, workspace, &b, &a, kind).await,
                    Err(RelationError::Cycle)
                );
                add(&db, workspace, &b, &c, kind).await.unwrap();
                assert_eq!(
                    add(&db, workspace, &c, &a, kind).await,
                    Err(RelationError::Cycle)
                );
            }
            assert_eq!(
                add(&db, workspace, &c, &a, RelationKind::Child).await,
                Err(RelationError::AlreadyHasParent)
            );
            crate::issues::set_status(&db, workspace, &b, "done")
                .await
                .unwrap();
            let links = list(&db, workspace, &a).await.unwrap();
            assert!(links
                .iter()
                .any(|link| link.kind == "parent" && link.status == "done" && link.id == b));
            assert_eq!(
                crate::issues::get(&db, workspace, &a)
                    .await
                    .unwrap()
                    .summary
                    .status,
                "todo"
            );
        });
    }

    #[test]
    fn upgrade_and_concurrent_inserts_cannot_create_a_cycle() {
        tauri::async_runtime::block_on(async {
            let fixture = TempDatabase::new("relationships-concurrent");
            let db = fixture.open().await;
            migrator(9).await.run(&db).await.unwrap();
            let a = add_issue_before_upgrade(&db, DEFAULT_WORKSPACE, None).await;
            let b = add_issue_before_upgrade(&db, DEFAULT_WORKSPACE, None).await;
            migrator(10).await.run(&db).await.unwrap();
            assert!(list(&db, DEFAULT_WORKSPACE, &a).await.unwrap().is_empty());
            let forward = tauri::async_runtime::spawn({
                let (db, a, b) = (db.clone(), a.clone(), b.clone());
                async move { add(&db, DEFAULT_WORKSPACE, &a, &b, RelationKind::Blocks).await }
            });
            let reverse = add(&db, DEFAULT_WORKSPACE, &b, &a, RelationKind::Blocks).await;
            let forward = forward.await.unwrap();
            assert!(matches!(
                (forward, reverse),
                (Ok(()), Err(RelationError::Cycle)) | (Err(RelationError::Cycle), Ok(()))
            ));
            assert_eq!(list(&db, DEFAULT_WORKSPACE, &a).await.unwrap().len(), 1);
            db.close().await;
        });
    }
}
