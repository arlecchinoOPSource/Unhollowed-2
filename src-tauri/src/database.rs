use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{plugin::TauriPlugin, Runtime, State};
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind, PluginConfig};

const DATABASE: &str = "sqlite:workspace.sqlite3";

/// Every migration shipped with the app, in version order. Add new files here
/// and never edit or remove a migration that has already shipped.
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "Create the workspace root",
            sql: include_str!("../migrations/0001_workspace.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "Record the active workspace",
            sql: include_str!("../migrations/0002_active_workspace.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R, Option<PluginConfig>> {
    tauri_plugin_sql::Builder::default()
        .add_migrations(DATABASE, migrations())
        .build()
}

/// A workspace row. Its `id` is the stable UUID that owns all other records.
#[derive(Debug, PartialEq)]
pub struct Workspace {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatus {
    workspace_id: String,
    workspace_name: String,
}

impl From<Workspace> for DatabaseStatus {
    fn from(workspace: Workspace) -> Self {
        Self {
            workspace_id: workspace.id,
            workspace_name: workspace.name,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum DatabaseError {
    DatabaseUnavailable,
    WorkspaceReadFailed,
}

/// Reads the workspace the app is currently working in. Feature commands
/// should call this and scope their queries by the returned ID.
pub async fn active_workspace(pool: &SqlitePool) -> Result<Workspace, DatabaseError> {
    let (id, name) = sqlx::query_as(
        "SELECT w.id, w.name
         FROM app_state AS s
         JOIN workspaces AS w ON w.id = s.active_workspace_id
         WHERE s.singleton = 1",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| {
        eprintln!("Active workspace query failed: {error}");
        DatabaseError::WorkspaceReadFailed
    })?;
    Ok(Workspace { id, name })
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
    active_workspace(&pool).await.map(DatabaseStatus::from)
}

#[cfg(test)]
mod tests {
    use super::{active_workspace, migrations, DatabaseError, Workspace};
    use sqlx::{
        migrate::Migrator,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
        SqlitePool,
    };
    use std::path::{Path, PathBuf};

    const DEFAULT_WORKSPACE: &str = "00000000-0000-4000-8000-000000000001";

    async fn migrator(up_to: i64) -> Migrator {
        let mut migrator = Migrator::new(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/migrations"
        )))
        .await
        .unwrap();
        let kept: Vec<_> = migrator
            .migrations
            .iter()
            .filter(|migration| migration.version <= up_to)
            .cloned()
            .collect();
        migrator.migrations = kept.into();
        migrator
    }

    async fn memory_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap()
    }

    /// A disposable on-disk database that is removed when the test ends.
    struct TempDatabase(PathBuf);

    impl TempDatabase {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "unhollowed-2-{name}-{}.sqlite3",
                std::process::id()
            ));
            let database = Self(path);
            database.remove();
            database
        }

        async fn open(&self) -> SqlitePool {
            SqlitePool::connect_with(
                SqliteConnectOptions::new()
                    .filename(&self.0)
                    .create_if_missing(true),
            )
            .await
            .unwrap()
        }

        fn remove(&self) {
            for suffix in ["", "-wal", "-shm"] {
                let mut file = self.0.clone().into_os_string();
                file.push(suffix);
                let _ = std::fs::remove_file(file);
            }
        }
    }

    impl Drop for TempDatabase {
        fn drop(&mut self) {
            self.remove();
        }
    }

    fn personal() -> Workspace {
        Workspace {
            id: DEFAULT_WORKSPACE.into(),
            name: "Personal".into(),
        }
    }

    #[test]
    fn registered_migrations_match_the_migration_files() {
        tauri::async_runtime::block_on(async {
            let files = migrator(i64::MAX).await;
            let registered = migrations();
            assert_eq!(files.migrations.len(), registered.len());
            for (file, registered) in files.migrations.iter().zip(&registered) {
                assert_eq!(file.version, registered.version);
                assert_eq!(file.sql, registered.sql);
            }
        });
    }

    #[test]
    fn fresh_database_initializes_the_active_workspace_once() {
        tauri::async_runtime::block_on(async {
            let pool = memory_pool().await;
            let migrations = migrator(i64::MAX).await;
            migrations.run(&pool).await.unwrap();
            migrations.run(&pool).await.unwrap();

            let workspaces: Vec<(String, String)> =
                sqlx::query_as("SELECT id, name FROM workspaces")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                workspaces,
                vec![(DEFAULT_WORKSPACE.into(), "Personal".into())]
            );
            assert_eq!(active_workspace(&pool).await.unwrap(), personal());
        });
    }

    #[test]
    fn phase_0_database_upgrades_and_keeps_its_workspace() {
        tauri::async_runtime::block_on(async {
            let database = TempDatabase::new("phase-0-upgrade");

            // A Phase 0 database only has migration 1 applied.
            let pool = database.open().await;
            migrator(1).await.run(&pool).await.unwrap();
            sqlx::query("INSERT INTO workspaces (id, name) VALUES (?, ?)")
                .bind("00000000-0000-4000-8000-000000000002")
                .bind("Existing")
                .execute(&pool)
                .await
                .unwrap();
            assert!(active_workspace(&pool).await.is_err());
            pool.close().await;

            // Reopening with the current migrations upgrades it in place.
            let pool = database.open().await;
            migrator(i64::MAX).await.run(&pool).await.unwrap();
            assert_eq!(active_workspace(&pool).await.unwrap(), personal());

            let workspaces: Vec<(String, String)> =
                sqlx::query_as("SELECT id, name FROM workspaces ORDER BY id")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                workspaces,
                vec![
                    (DEFAULT_WORKSPACE.into(), "Personal".into()),
                    (
                        "00000000-0000-4000-8000-000000000002".into(),
                        "Existing".into()
                    ),
                ]
            );
            let applied: Vec<(i64, bool)> =
                sqlx::query_as("SELECT version, success FROM _sqlx_migrations ORDER BY version")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(applied, vec![(1, true), (2, true)]);
            pool.close().await;
        });
    }

    #[test]
    fn active_workspace_must_reference_an_existing_workspace() {
        tauri::async_runtime::block_on(async {
            let pool = memory_pool().await;
            migrator(i64::MAX).await.run(&pool).await.unwrap();

            assert!(
                sqlx::query("UPDATE app_state SET active_workspace_id = 'missing'")
                    .execute(&pool)
                    .await
                    .is_err()
            );
            assert!(sqlx::query("DELETE FROM workspaces WHERE id = ?")
                .bind(DEFAULT_WORKSPACE)
                .execute(&pool)
                .await
                .is_err());
            assert!(sqlx::query(
                "INSERT INTO app_state (singleton, active_workspace_id) VALUES (2, ?)"
            )
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .is_err());
            assert_eq!(active_workspace(&pool).await.unwrap(), personal());
        });
    }

    #[test]
    fn reading_an_unmigrated_database_reports_a_typed_error() {
        tauri::async_runtime::block_on(async {
            let pool = memory_pool().await;
            assert!(matches!(
                active_workspace(&pool).await,
                Err(DatabaseError::WorkspaceReadFailed)
            ));
        });
    }
}
