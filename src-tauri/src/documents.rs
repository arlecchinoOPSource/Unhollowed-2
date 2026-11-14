use crate::database::{active_workspace, pool, DatabaseError};
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

const DEFAULT_TITLE: &str = "Untitled";
const EMPTY_CONTENT: &str = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
const MAX_TITLE_CHARS: usize = 200;
const MAX_CONTENT_BYTES: usize = 5 * 1024 * 1024;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub title: String,
    /// Tiptap JSON, stored and returned exactly as the editor produced it.
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum DocumentError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
    NotFound,
    InvalidTitle,
    InvalidContent,
    StorageFailed,
}

impl From<DatabaseError> for DocumentError {
    fn from(error: DatabaseError) -> Self {
        match error {
            DatabaseError::DatabaseUnavailable => Self::DatabaseUnavailable,
            DatabaseError::WorkspaceReadFailed => Self::WorkspaceReadFailed,
        }
    }
}

fn storage_failed(error: sqlx::Error) -> DocumentError {
    eprintln!("Document storage failed: {error}");
    DocumentError::StorageFailed
}

fn valid_title(title: &str) -> Result<&str, DocumentError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err(DocumentError::InvalidTitle);
    }
    Ok(title)
}

fn valid_content(content: &str) -> Result<&str, DocumentError> {
    if content.len() > MAX_CONTENT_BYTES {
        return Err(DocumentError::InvalidContent);
    }
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(value) if value.get("type").and_then(|kind| kind.as_str()) == Some("doc") => Ok(content),
        _ => Err(DocumentError::InvalidContent),
    }
}

type DocumentRow = (String, String, String, String, String);

fn document(row: DocumentRow) -> Document {
    let (id, title, content, created_at, updated_at) = row;
    Document {
        id,
        title,
        content,
        created_at,
        updated_at,
    }
}

/// Every query below filters by `workspace_id`, so a document ID from another
/// workspace behaves exactly like an ID that does not exist.
pub async fn list(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<Vec<DocumentSummary>, DocumentError> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, title, updated_at FROM documents
         WHERE workspace_id = ? ORDER BY updated_at DESC, id",
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;
    Ok(rows
        .into_iter()
        .map(|(id, title, updated_at)| DocumentSummary {
            id,
            title,
            updated_at,
        })
        .collect())
}

pub async fn get(
    pool: &SqlitePool,
    workspace_id: &str,
    id: &str,
) -> Result<Document, DocumentError> {
    sqlx::query_as::<_, DocumentRow>(
        "SELECT id, title, content, created_at, updated_at FROM documents
         WHERE id = ? AND workspace_id = ?",
    )
    .bind(id)
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .map_err(storage_failed)?
    .map(document)
    .ok_or(DocumentError::NotFound)
}

pub async fn create(
    pool: &SqlitePool,
    workspace_id: &str,
    title: Option<&str>,
) -> Result<Document, DocumentError> {
    let title = valid_title(title.unwrap_or(DEFAULT_TITLE))?;
    let id = Uuid::new_v4().to_string();
    sqlx::query(&format!(
        "INSERT INTO documents (id, workspace_id, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, {NOW}, {NOW})"
    ))
    .bind(&id)
    .bind(workspace_id)
    .bind(title)
    .bind(EMPTY_CONTENT)
    .execute(pool)
    .await
    .map_err(storage_failed)?;
    get(pool, workspace_id, &id).await
}

pub async fn update(
    pool: &SqlitePool,
    workspace_id: &str,
    id: &str,
    title: &str,
    content: &str,
) -> Result<Document, DocumentError> {
    let title = valid_title(title)?;
    let content = valid_content(content)?;
    let result = sqlx::query(&format!(
        "UPDATE documents SET title = ?, content = ?, updated_at = {NOW}
         WHERE id = ? AND workspace_id = ?"
    ))
    .bind(title)
    .bind(content)
    .bind(id)
    .bind(workspace_id)
    .execute(pool)
    .await
    .map_err(storage_failed)?;
    if result.rows_affected() == 0 {
        return Err(DocumentError::NotFound);
    }
    get(pool, workspace_id, id).await
}

/// The open database and the active workspace that every command is scoped to.
/// The webview never supplies a workspace ID.
async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), DocumentError> {
    let pool = pool(instances).await?;
    let workspace = active_workspace(&pool).await?;
    Ok((pool, workspace.id))
}

#[tauri::command]
pub async fn list_documents(
    instances: State<'_, DbInstances>,
) -> Result<Vec<DocumentSummary>, DocumentError> {
    let (pool, workspace_id) = scope(&instances).await?;
    list(&pool, &workspace_id).await
}

#[tauri::command]
pub async fn get_document(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<Document, DocumentError> {
    let (pool, workspace_id) = scope(&instances).await?;
    get(&pool, &workspace_id, &id).await
}

#[tauri::command]
pub async fn create_document(
    instances: State<'_, DbInstances>,
    title: Option<String>,
) -> Result<Document, DocumentError> {
    let (pool, workspace_id) = scope(&instances).await?;
    create(&pool, &workspace_id, title.as_deref()).await
}

#[tauri::command]
pub async fn update_document(
    instances: State<'_, DbInstances>,
    id: String,
    title: String,
    content: String,
) -> Result<Document, DocumentError> {
    let (pool, workspace_id) = scope(&instances).await?;
    update(&pool, &workspace_id, &id, &title, &content).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
    };

    const FORMATTED: &str = r#"{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Plan"}]},{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Bold"},{"type":"text","text":" and "},{"type":"text","marks":[{"type":"italic"}],"text":"italic"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Item"}]}]}]}]}"#;

    #[test]
    fn creates_and_lists_documents() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            assert!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().is_empty());

            let created = create(&pool, DEFAULT_WORKSPACE, None).await.unwrap();
            assert_eq!(created.title, "Untitled");
            assert_eq!(created.content, EMPTY_CONTENT);
            assert_eq!(created.id.len(), 36);

            let named = create(&pool, DEFAULT_WORKSPACE, Some("  Notes  "))
                .await
                .unwrap();
            assert_eq!(named.title, "Notes");

            let listed = list(&pool, DEFAULT_WORKSPACE).await.unwrap();
            assert_eq!(listed.len(), 2);
            assert!(listed.iter().any(|summary| summary.id == created.id));
        });
    }

    #[test]
    fn updates_keep_formatting_and_change_the_timestamp_field() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let created = create(&pool, DEFAULT_WORKSPACE, None).await.unwrap();

            let updated = update(&pool, DEFAULT_WORKSPACE, &created.id, " Plan ", FORMATTED)
                .await
                .unwrap();
            assert_eq!(updated.title, "Plan");
            assert_eq!(updated.content, FORMATTED);
            assert_eq!(updated.created_at, created.created_at);
            assert!(updated.updated_at >= created.updated_at);
            assert_eq!(
                get(&pool, DEFAULT_WORKSPACE, &created.id).await.unwrap(),
                updated
            );
        });
    }

    #[test]
    fn rejects_cross_workspace_access() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
            let owned = create(&pool, DEFAULT_WORKSPACE, Some("Private"))
                .await
                .unwrap();

            assert!(list(&pool, OTHER_WORKSPACE).await.unwrap().is_empty());
            assert_eq!(
                get(&pool, OTHER_WORKSPACE, &owned.id).await,
                Err(DocumentError::NotFound)
            );
            assert_eq!(
                update(&pool, OTHER_WORKSPACE, &owned.id, "Taken", FORMATTED).await,
                Err(DocumentError::NotFound)
            );
            assert_eq!(
                get(&pool, DEFAULT_WORKSPACE, &owned.id).await.unwrap(),
                owned
            );
            assert_eq!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().len(), 1);
        });
    }

    #[test]
    fn rejects_invalid_input_without_changing_the_document() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let created = create(&pool, DEFAULT_WORKSPACE, Some("Keep"))
                .await
                .unwrap();
            let id = &created.id;

            assert_eq!(
                update(&pool, DEFAULT_WORKSPACE, id, "   ", FORMATTED).await,
                Err(DocumentError::InvalidTitle)
            );
            assert_eq!(
                update(&pool, DEFAULT_WORKSPACE, id, &"x".repeat(201), FORMATTED).await,
                Err(DocumentError::InvalidTitle)
            );
            for content in ["not json", "[]", r#"{"type":"paragraph"}"#, ""] {
                assert_eq!(
                    update(&pool, DEFAULT_WORKSPACE, id, "Keep", content).await,
                    Err(DocumentError::InvalidContent)
                );
            }
            let oversized = format!(
                r#"{{"type":"doc","pad":"{}"}}"#,
                "x".repeat(MAX_CONTENT_BYTES)
            );
            assert_eq!(
                update(&pool, DEFAULT_WORKSPACE, id, "Keep", &oversized).await,
                Err(DocumentError::InvalidContent)
            );
            assert_eq!(
                create(&pool, DEFAULT_WORKSPACE, Some(" ")).await,
                Err(DocumentError::InvalidTitle)
            );
            assert_eq!(get(&pool, DEFAULT_WORKSPACE, id).await.unwrap(), created);
        });
    }

    #[test]
    fn documents_reopen_after_restart_with_formatting_intact() {
        tauri::async_runtime::block_on(async {
            let database = TempDatabase::new("documents-reopen");
            let pool = database.open().await;
            migrator(i64::MAX).await.run(&pool).await.unwrap();
            let created = create(&pool, DEFAULT_WORKSPACE, Some("Saved"))
                .await
                .unwrap();
            let saved = update(&pool, DEFAULT_WORKSPACE, &created.id, "Saved", FORMATTED)
                .await
                .unwrap();
            pool.close().await;

            let pool = database.open().await;
            migrator(i64::MAX).await.run(&pool).await.unwrap();
            assert_eq!(
                get(&pool, DEFAULT_WORKSPACE, &created.id).await.unwrap(),
                saved
            );
            assert_eq!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().len(), 1);
            pool.close().await;
        });
    }

    #[test]
    fn existing_databases_upgrade_without_losing_data() {
        tauri::async_runtime::block_on(async {
            let database = TempDatabase::new("documents-upgrade");
            let pool = database.open().await;
            migrator(2).await.run(&pool).await.unwrap();
            add_workspace(&pool, OTHER_WORKSPACE, "Existing").await;
            pool.close().await;

            let pool = database.open().await;
            migrator(i64::MAX).await.run(&pool).await.unwrap();
            let workspaces: Vec<(String, String)> =
                sqlx::query_as("SELECT id, name FROM workspaces ORDER BY id")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                workspaces,
                vec![
                    (DEFAULT_WORKSPACE.into(), "Personal".into()),
                    (OTHER_WORKSPACE.into(), "Existing".into()),
                ]
            );
            let (active,): (String,) = sqlx::query_as("SELECT active_workspace_id FROM app_state")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(active, DEFAULT_WORKSPACE);
            assert!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().is_empty());
            create(&pool, OTHER_WORKSPACE, Some("After upgrade"))
                .await
                .unwrap();
            pool.close().await;
        });
    }

    #[test]
    fn the_schema_enforces_ownership_and_valid_content() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let insert = "INSERT INTO documents
                (id, workspace_id, title, content, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'now', 'now')";

            assert!(sqlx::query(insert)
                .bind("a")
                .bind("missing-workspace")
                .bind("T")
                .bind(EMPTY_CONTENT)
                .execute(&pool)
                .await
                .is_err());
            assert!(sqlx::query(insert)
                .bind("b")
                .bind(DEFAULT_WORKSPACE)
                .bind("T")
                .bind("not json")
                .execute(&pool)
                .await
                .is_err());

            create(&pool, DEFAULT_WORKSPACE, None).await.unwrap();
            assert!(sqlx::query("DELETE FROM workspaces WHERE id = ?")
                .bind(DEFAULT_WORKSPACE)
                .execute(&pool)
                .await
                .is_err());
        });
    }
}
