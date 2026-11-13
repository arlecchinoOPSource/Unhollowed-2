use serde::Serialize;
use tauri::{plugin::TauriPlugin, Runtime, State};
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind, PluginConfig};

const DATABASE: &str = "sqlite:workspace.sqlite3";
const DEFAULT_WORKSPACE: &str = "00000000-0000-4000-8000-000000000001";

pub fn plugin<R: Runtime>() -> TauriPlugin<R, Option<PluginConfig>> {
    tauri_plugin_sql::Builder::default()
        .add_migrations(
            DATABASE,
            vec![Migration {
                version: 1,
                description: "Create the workspace root",
                sql: include_str!("../migrations/0001_workspace.sql"),
                kind: MigrationKind::Up,
            }],
        )
        .build()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatus {
    workspace_id: String,
    workspace_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum DatabaseError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
}

#[tauri::command]
pub async fn database_status(
    instances: State<'_, DbInstances>,
) -> Result<DatabaseStatus, DatabaseError> {
    let pool = {
        let instances = instances.0.read().await;
        let Some(DbPool::Sqlite(pool)) = instances.get(DATABASE) else {
            return Err(DatabaseError::DatabaseUnavailable);
        };
        pool.clone()
    };
    let (workspace_id, workspace_name) =
        sqlx::query_as("SELECT id, name FROM workspaces WHERE id = ?")
            .bind(DEFAULT_WORKSPACE)
            .fetch_one(&pool)
            .await
            .map_err(|error| {
                eprintln!("Local workspace query failed: {error}");
                DatabaseError::WorkspaceReadFailed
            })?;
    Ok(DatabaseStatus {
        workspace_id,
        workspace_name,
    })
}

#[cfg(test)]
mod tests {
    use super::DEFAULT_WORKSPACE;
    use sqlx::{migrate::Migrator, SqlitePool};

    #[test]
    fn workspace_migration_seeds_the_default_workspace_once() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
            let migrations = Migrator::new(std::path::Path::new(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/migrations"
            )))
            .await
            .unwrap();

            migrations.run(&pool).await.unwrap();
            migrations.run(&pool).await.unwrap();

            let rows: Vec<(String, String)> = sqlx::query_as("SELECT id, name FROM workspaces")
                .fetch_all(&pool)
                .await
                .unwrap();
            assert_eq!(rows, vec![(DEFAULT_WORKSPACE.into(), "Personal".into())]);
        });
    }
}
