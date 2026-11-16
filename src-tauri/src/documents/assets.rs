use super::{scope, storage_failed, DocumentError};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

const MAX_BYTES: usize = 8 * 1024 * 1024;

fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

async fn store(
    db: &SqlitePool,
    workspace: &str,
    document: &str,
    encoded: &str,
) -> Result<String, DocumentError> {
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(DocumentError::InvalidContent);
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| DocumentError::InvalidContent)?;
    let mime = mime(&bytes)
        .filter(|_| bytes.len() <= MAX_BYTES)
        .ok_or(DocumentError::InvalidContent)?;
    let id = Uuid::new_v4().to_string();
    let inserted = sqlx::query(
        "INSERT INTO document_assets (id, workspace_id, document_id, mime, bytes)
         SELECT ?, workspace_id, id, ?, ? FROM documents WHERE workspace_id = ? AND id = ?",
    )
    .bind(&id)
    .bind(mime)
    .bind(bytes)
    .bind(workspace)
    .bind(document)
    .execute(db)
    .await
    .map_err(storage_failed)?;
    if inserted.rows_affected() == 0 {
        return Err(DocumentError::NotFound);
    }
    Ok(id)
}

#[derive(Serialize)]
pub struct ImageAsset {
    mime: String,
    data: String,
}

async fn read(
    db: &SqlitePool,
    workspace: &str,
    document: &str,
    id: &str,
) -> Result<ImageAsset, DocumentError> {
    let (mime, bytes): (String, Vec<u8>) = sqlx::query_as(
        "SELECT mime, bytes FROM document_assets WHERE workspace_id = ? AND document_id = ? AND id = ?",
    ).bind(workspace).bind(document).bind(id).fetch_optional(db).await
        .map_err(storage_failed)?.ok_or(DocumentError::NotFound)?;
    Ok(ImageAsset {
        mime,
        data: STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub async fn store_document_image(
    instances: State<'_, DbInstances>,
    document_id: String,
    data: String,
) -> Result<String, DocumentError> {
    let (db, workspace) = scope(&instances).await?;
    store(&db, &workspace, &document_id, &data).await
}

#[tauri::command]
pub async fn get_document_image(
    instances: State<'_, DbInstances>,
    document_id: String,
    id: String,
) -> Result<ImageAsset, DocumentError> {
    let (db, workspace) = scope(&instances).await?;
    read(&db, &workspace, &document_id, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE};

    #[test]
    fn images_are_owned_by_the_document_and_survive_reopen() {
        tauri::async_runtime::block_on(async {
            let fixture = TempDatabase::new("document-images");
            let db = fixture.open().await;
            migrator(i64::MAX).await.run(&db).await.unwrap();
            let doc = super::super::create(&db, DEFAULT_WORKSPACE, None)
                .await
                .unwrap();
            let other = super::super::create(&db, DEFAULT_WORKSPACE, None)
                .await
                .unwrap();
            let image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
            let id = store(&db, DEFAULT_WORKSPACE, &doc.id, image).await.unwrap();
            assert!(matches!(
                store(&db, DEFAULT_WORKSPACE, &doc.id, "PHN2Zz4=").await,
                Err(DocumentError::InvalidContent)
            ));
            assert!(matches!(
                store(&db, OTHER_WORKSPACE, &doc.id, image).await,
                Err(DocumentError::NotFound)
            ));
            db.close().await;
            let db = fixture.open().await;
            let loaded = read(&db, DEFAULT_WORKSPACE, &doc.id, &id).await.unwrap();
            assert_eq!(loaded.mime, "image/png");
            assert_eq!(loaded.data, image);
            assert!(read(&db, DEFAULT_WORKSPACE, &other.id, &id).await.is_err());
            assert!(read(&db, OTHER_WORKSPACE, &doc.id, &id).await.is_err());
            db.close().await;
        });
    }
}
