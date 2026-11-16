use super::{scope, storage_failed, DocumentError};
use serde::Serialize;
use sqlx::FromRow;
use tauri::State;
use tauri_plugin_sql::DbInstances;

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    id: String,
    title: String,
    incoming: bool,
}

#[tauri::command]
pub async fn list_document_references(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Vec<Reference>, DocumentError> {
    let (pool, workspace) = scope(&instances).await?;
    sqlx::query_as(
        "SELECT d.id, d.title, 0 AS incoming FROM document_references r
           JOIN documents d ON d.workspace_id = r.workspace_id AND d.id = r.target_id
           WHERE r.workspace_id = ?1 AND r.source_id = ?2
         UNION ALL
         SELECT d.id, d.title, 1 AS incoming FROM document_references r
           JOIN documents d ON d.workspace_id = r.workspace_id AND d.id = r.source_id
           WHERE r.workspace_id = ?1 AND r.target_id = ?2
         ORDER BY incoming, title, id",
    )
    .bind(workspace)
    .bind(id)
    .fetch_all(&pool)
    .await
    .map_err(storage_failed)
}

#[cfg(test)]
mod tests {
    use crate::documents::{create, update};
    use crate::test_support::{add_workspace, migrated_pool, DEFAULT_WORKSPACE, OTHER_WORKSPACE};
    use serde_json::json;

    #[test]
    fn indexes_distinct_links_in_one_workspace_and_removes_deleted_marks() {
        tauri::async_runtime::block_on(async {
            let db = migrated_pool().await;
            add_workspace(&db, OTHER_WORKSPACE, "Other").await;
            let source = create(&db, DEFAULT_WORKSPACE, Some("Notes")).await.unwrap();
            let target = create(&db, DEFAULT_WORKSPACE, Some("Plan")).await.unwrap();
            let foreign = create(&db, OTHER_WORKSPACE, Some("Foreign")).await.unwrap();
            let reference = |id: &str| {
                json!({
                    "type": "text", "text": "Plan",
                    "marks": [{ "type": "documentReference", "attrs": { "targetId": id } }]
                })
            };
            let body = json!({ "type": "doc", "content": [{ "type": "paragraph", "content":
                [reference(&target.id), reference(&target.id), reference(&foreign.id), reference(&source.id)]
            }]});
            update(
                &db,
                DEFAULT_WORKSPACE,
                &source.id,
                "Notes",
                &body.to_string(),
            )
            .await
            .unwrap();
            update(
                &db,
                DEFAULT_WORKSPACE,
                &target.id,
                "Renamed",
                &target.content,
            )
            .await
            .unwrap();
            let edges: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT r.workspace_id, r.source_id, d.title FROM document_references r
                 JOIN documents d ON d.id = r.target_id",
            )
            .fetch_all(&db)
            .await
            .unwrap();
            assert_eq!(
                edges,
                vec![(
                    DEFAULT_WORKSPACE.to_owned(),
                    source.id.clone(),
                    "Renamed".into()
                )]
            );
            update(&db, DEFAULT_WORKSPACE, &source.id, "Notes", &source.content)
                .await
                .unwrap();
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM document_references")
                .fetch_one(&db)
                .await
                .unwrap();
            assert_eq!(count, 0);
        });
    }
}
