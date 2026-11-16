use super::{scope, storage_failed, Document, DocumentError, NOW};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    id: i64,
    title: String,
    saved_at: String,
}

#[tauri::command]
pub async fn list_document_revisions(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Vec<Revision>, DocumentError> {
    let (db, workspace) = scope(&instances).await?;
    sqlx::query_as(
        "SELECT id, title, saved_at FROM document_revisions
         WHERE workspace_id = ? AND document_id = ? ORDER BY id DESC",
    )
    .bind(workspace)
    .bind(id)
    .fetch_all(&db)
    .await
    .map_err(storage_failed)
}

async fn restore(
    db: &SqlitePool,
    workspace: &str,
    id: &str,
    revision: i64,
) -> Result<Document, DocumentError> {
    let mut tx = db
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(storage_failed)?;
    let (title, content): (String, String) = sqlx::query_as(
        "SELECT title, content FROM document_revisions
         WHERE workspace_id = ? AND document_id = ? AND id = ?",
    )
    .bind(workspace)
    .bind(id)
    .bind(revision)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage_failed)?
    .ok_or(DocumentError::NotFound)?;
    // Save the displaced version first, even if the ordinary checkpoint is
    // still within its cooldown. Reading the target first also protects a
    // restore of the oldest entry from the retention trigger.
    sqlx::query(
        "INSERT INTO document_revisions (workspace_id, document_id, title, content)
         SELECT workspace_id, id, title, content FROM documents WHERE workspace_id = ? AND id = ?",
    )
    .bind(workspace)
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(storage_failed)?;
    let (id, title, content, created_at, updated_at) = sqlx::query_as(&format!(
        "UPDATE documents SET title = ?, content = ?, updated_at = {NOW}
         WHERE workspace_id = ? AND id = ?
         RETURNING id, title, content, created_at, updated_at"
    ))
    .bind(title)
    .bind(content)
    .bind(workspace)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage_failed)?
    .ok_or(DocumentError::NotFound)?;
    tx.commit().await.map_err(storage_failed)?;
    Ok(Document {
        id,
        title,
        content,
        created_at,
        updated_at,
    })
}

#[tauri::command]
pub async fn restore_document_revision(
    instances: State<'_, DbInstances>,
    id: String,
    revision: i64,
) -> Result<Document, DocumentError> {
    let (db, workspace) = scope(&instances).await?;
    restore(&db, &workspace, &id, revision).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE};

    #[test]
    fn upgraded_document_checkpoints_restore_the_previous_and_displaced_versions() {
        tauri::async_runtime::block_on(async {
            let fixture = TempDatabase::new("document-revisions");
            let db = fixture.open().await;
            let workspace = DEFAULT_WORKSPACE;
            migrator(14).await.run(&db).await.unwrap();
            let initial = super::super::create(&db, workspace, Some("Legacy"))
                .await
                .unwrap();
            db.close().await;
            let db = fixture.open().await;
            migrator(i64::MAX).await.run(&db).await.unwrap();
            let id = &initial.id;
            let original = super::super::get(&db, workspace, id).await.unwrap();
            assert_eq!(original, initial);
            for title in ["Draft", "Latest"] {
                super::super::update(&db, workspace, id, title, &initial.content)
                    .await
                    .unwrap();
            }
            let revisions: Vec<i64> = sqlx::query_scalar("SELECT id FROM document_revisions")
                .fetch_all(&db)
                .await
                .unwrap();
            assert_eq!(revisions.len(), 1);
            assert!(matches!(
                restore(&db, OTHER_WORKSPACE, id, revisions[0]).await,
                Err(DocumentError::NotFound)
            ));
            assert_eq!(
                restore(&db, workspace, id, revisions[0])
                    .await
                    .unwrap()
                    .title,
                "Legacy"
            );
            let displaced =
                sqlx::query_scalar("SELECT id FROM document_revisions ORDER BY id DESC LIMIT 1")
                    .fetch_one(&db)
                    .await
                    .unwrap();
            assert_eq!(
                restore(&db, workspace, id, displaced).await.unwrap().title,
                "Latest"
            );
            for _ in 0..25 {
                restore(&db, workspace, id, displaced_or_latest(&db).await)
                    .await
                    .unwrap();
            }
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM document_revisions")
                .fetch_one(&db)
                .await
                .unwrap();
            assert_eq!(count, 20);
            db.close().await;
        });
    }

    async fn displaced_or_latest(db: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT id FROM document_revisions ORDER BY id DESC LIMIT 1")
            .fetch_one(db)
            .await
            .unwrap()
    }
}
