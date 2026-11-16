use super::{scope, storage_failed, valid_content, valid_title, DocumentError, EMPTY_CONTENT, NOW};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, SqlitePool};
use std::collections::HashMap;
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDocument {
    pub id: String,
    title: String,
    folder_id: Option<String>,
    favorite: bool,
    archived_at: Option<String>,
    opened_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    id: String,
    parent_id: Option<String>,
    name: String,
}

#[derive(Serialize)]
pub struct Library {
    documents: Vec<LibraryDocument>,
    folders: Vec<Folder>,
}

const FIELDS: &str =
    "id, title, folder_id, favorite, archived_at, opened_at, created_at, updated_at";

#[tauri::command]
pub async fn list_document_library(
    instances: State<'_, DbInstances>,
) -> Result<Library, DocumentError> {
    let (db, workspace) = scope(&instances).await?;
    let documents = sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM documents WHERE workspace_id = ? ORDER BY updated_at DESC, id"
    ))
    .bind(&workspace)
    .fetch_all(&db)
    .await
    .map_err(storage_failed)?;
    let folders = sqlx::query_as("SELECT id, parent_id, name FROM document_folders WHERE workspace_id = ? ORDER BY name COLLATE NOCASE, id")
        .bind(workspace).fetch_all(&db).await.map_err(storage_failed)?;
    Ok(Library { documents, folders })
}

#[tauri::command]
pub async fn create_document_folder(
    instances: State<'_, DbInstances>,
    name: String,
    parent_id: Option<String>,
) -> Result<Folder, DocumentError> {
    let (db, workspace) = scope(&instances).await?;
    let name = valid_title(&name)?;
    sqlx::query_as(
        "INSERT INTO document_folders (id, name, parent_id, workspace_id)
        SELECT ?3, ?4, ?1, ?2 WHERE ?1 IS NULL OR EXISTS (
          SELECT 1 FROM document_folders WHERE id = ?1 AND workspace_id = ?2)
        RETURNING id, name, parent_id",
    )
    .bind(parent_id)
    .bind(workspace)
    .bind(Uuid::new_v4().to_string())
    .bind(name)
    .fetch_optional(&db)
    .await
    .map_err(storage_failed)?
    .ok_or(DocumentError::NotFound)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LibraryChange {
    Favorite { value: bool },
    Archive,
    Restore,
    Open,
    Move { folder: Option<String> },
}

async fn change(
    db: &SqlitePool,
    workspace: &str,
    id: &str,
    input: LibraryChange,
) -> Result<LibraryDocument, DocumentError> {
    let (assignment, extra_filter) = match input {
        LibraryChange::Favorite { .. } => ("favorite = ?3".to_owned(), ""),
        LibraryChange::Archive => (format!("archived_at = coalesce(archived_at, {NOW})"), ""),
        LibraryChange::Restore => ("archived_at = NULL".to_owned(), ""),
        LibraryChange::Open => (format!("opened_at = {NOW}"), ""),
        LibraryChange::Move { .. } => ("folder_id = ?3".to_owned(), "AND (?3 IS NULL OR EXISTS (SELECT 1 FROM document_folders WHERE workspace_id = ?2 AND id = ?3))"),
    };
    let sql = format!("UPDATE documents SET {assignment} WHERE id = ?1 AND workspace_id = ?2 {extra_filter} RETURNING {FIELDS}");
    let query = sqlx::query_as(&sql).bind(id).bind(workspace);
    let query = match input {
        LibraryChange::Favorite { value } => query.bind(value),
        LibraryChange::Move { folder } => query.bind(folder),
        _ => query,
    };
    query
        .fetch_optional(db)
        .await
        .map_err(storage_failed)?
        .ok_or(DocumentError::NotFound)
}

#[tauri::command]
pub async fn change_document_library(
    instances: State<'_, DbInstances>,
    id: String,
    input: LibraryChange,
) -> Result<LibraryDocument, DocumentError> {
    let (db, workspace) = scope(&instances).await?;
    change(&db, &workspace, &id, input).await
}

#[tauri::command]
pub async fn create_library_document(
    instances: State<'_, DbInstances>,
    title: String,
    content: Option<String>,
    folder: Option<String>,
) -> Result<LibraryDocument, DocumentError> {
    let (db, workspace) = scope(&instances).await?;
    sqlx::query_as(&format!(
        "INSERT INTO documents (id, workspace_id, title, content, folder_id, created_at, updated_at, opened_at)
         SELECT ?1, ?2, ?3, ?4, ?5, {NOW}, {NOW}, {NOW}
         WHERE ?5 IS NULL OR EXISTS (SELECT 1 FROM document_folders WHERE workspace_id = ?2 AND id = ?5)
         RETURNING {FIELDS}"
    )).bind(Uuid::new_v4().to_string()).bind(workspace).bind(valid_title(&title)?)
        .bind(valid_content(content.as_deref().unwrap_or(EMPTY_CONTENT))?).bind(folder)
        .fetch_optional(&db).await.map_err(storage_failed)?.ok_or(DocumentError::NotFound)
}

fn remap_images(node: &mut Value, assets: &HashMap<String, String>) {
    if node["type"] == "localImage" {
        if let Some(replacement) = node["attrs"]["assetId"]
            .as_str()
            .and_then(|id| assets.get(id))
        {
            node["attrs"]["assetId"] = Value::String(replacement.clone());
        }
    }
    if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
        for child in children {
            remap_images(child, assets);
        }
    }
}

async fn duplicate(
    db: &SqlitePool,
    workspace: &str,
    id: &str,
) -> Result<LibraryDocument, DocumentError> {
    let mut tx = db
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(storage_failed)?;
    let (title, content, folder): (String, String, Option<String>) = sqlx::query_as(
        "SELECT title, content, folder_id FROM documents WHERE workspace_id = ? AND id = ?",
    )
    .bind(workspace)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage_failed)?
    .ok_or(DocumentError::NotFound)?;
    let new_id = Uuid::new_v4().to_string();
    let title = format!("{} (copy)", title.chars().take(193).collect::<String>());
    let asset_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM document_assets WHERE workspace_id = ? AND document_id = ?",
    )
    .bind(workspace)
    .bind(id)
    .fetch_all(&mut *tx)
    .await
    .map_err(storage_failed)?;
    let mapping: HashMap<_, _> = asset_ids
        .into_iter()
        .map(|old| (old, Uuid::new_v4().to_string()))
        .collect();
    let mut body: Value =
        serde_json::from_str(&content).map_err(|_| DocumentError::InvalidContent)?;
    let serialized = if mapping.is_empty() {
        content
    } else {
        remap_images(&mut body, &mapping);
        body.to_string()
    };
    let inserted = sqlx::query_as(&format!(
        "INSERT INTO documents (id, workspace_id, title, content, folder_id, created_at, updated_at, opened_at)
         VALUES (?, ?, ?, ?, ?, {NOW}, {NOW}, {NOW}) RETURNING {FIELDS}"
    )).bind(&new_id).bind(workspace).bind(title).bind(valid_content(&serialized)?).bind(folder)
       .fetch_one(&mut *tx).await.map_err(storage_failed)?;
    for (old, new) in mapping {
        sqlx::query("INSERT INTO document_assets (id, workspace_id, document_id, mime, bytes)
                     SELECT ?, workspace_id, ?, mime, bytes FROM document_assets WHERE workspace_id = ? AND id = ?")
            .bind(new).bind(&new_id).bind(workspace).bind(old).execute(&mut *tx).await.map_err(storage_failed)?;
    }
    tx.commit().await.map_err(storage_failed)?;
    Ok(inserted)
}

#[tauri::command]
pub async fn duplicate_document(
    instances: State<'_, DbInstances>,
    id: String,
) -> Result<LibraryDocument, DocumentError> {
    let (db, workspace) = scope(&instances).await?;
    duplicate(&db, &workspace, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{add_workspace, migrated_pool, DEFAULT_WORKSPACE, OTHER_WORKSPACE};

    #[test]
    fn library_changes_preserve_identity_and_cannot_cross_workspaces() {
        tauri::async_runtime::block_on(async {
            let db = migrated_pool().await;
            add_workspace(&db, OTHER_WORKSPACE, "Other").await;
            let first = super::super::create(&db, DEFAULT_WORKSPACE, Some("Source"))
                .await
                .unwrap();
            sqlx::query("INSERT INTO document_folders (id, workspace_id, name) VALUES ('root', ?, 'Root'), ('foreign', ?, 'Other')")
                .bind(DEFAULT_WORKSPACE).bind(OTHER_WORKSPACE).execute(&db).await.unwrap();
            sqlx::query("INSERT INTO document_folders (id, workspace_id, name, parent_id) VALUES ('child', ?, 'Child', 'root')")
                .bind(DEFAULT_WORKSPACE).execute(&db).await.unwrap();
            assert!(change(
                &db,
                DEFAULT_WORKSPACE,
                &first.id,
                LibraryChange::Move {
                    folder: Some("foreign".into())
                }
            )
            .await
            .is_err());
            let moved = change(
                &db,
                DEFAULT_WORKSPACE,
                &first.id,
                LibraryChange::Move {
                    folder: Some("child".into()),
                },
            )
            .await
            .unwrap();
            assert_eq!(moved.folder_id.as_deref(), Some("child"));
            assert!(
                change(
                    &db,
                    DEFAULT_WORKSPACE,
                    &first.id,
                    LibraryChange::Favorite { value: true }
                )
                .await
                .unwrap()
                .favorite
            );
            assert!(
                change(&db, OTHER_WORKSPACE, &first.id, LibraryChange::Archive)
                    .await
                    .is_err()
            );
            assert!(
                change(&db, DEFAULT_WORKSPACE, &first.id, LibraryChange::Archive)
                    .await
                    .unwrap()
                    .archived_at
                    .is_some()
            );
            assert!(super::super::list(&db, DEFAULT_WORKSPACE)
                .await
                .unwrap()
                .is_empty());
            assert!(
                change(&db, DEFAULT_WORKSPACE, &first.id, LibraryChange::Restore)
                    .await
                    .unwrap()
                    .archived_at
                    .is_none()
            );
            let copy = duplicate(&db, DEFAULT_WORKSPACE, &first.id).await.unwrap();
            assert_ne!(copy.id, first.id);
            assert_eq!(copy.folder_id, moved.folder_id);
            assert_eq!(
                super::super::get(&db, DEFAULT_WORKSPACE, &copy.id)
                    .await
                    .unwrap()
                    .content,
                first.content
            );
        });
    }
}
