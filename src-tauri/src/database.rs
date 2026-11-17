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
        Migration {
            version: 3,
            description: "Create workspace documents",
            sql: include_str!("../migrations/0003_documents.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "Create workspace projects",
            sql: include_str!("../migrations/0004_projects.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "Create workspace issues",
            sql: include_str!("../migrations/0005_issues.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "Add issue search text",
            sql: include_str!("../migrations/0006_issue_search.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "Create workspace labels",
            sql: include_str!("../migrations/0007_labels.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "Create milestones",
            sql: include_str!("../migrations/0008_milestones.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "Create project missions and objectives",
            sql: include_str!("../migrations/0009_project_goals.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "Create issue relationships",
            sql: include_str!("../migrations/0010_issue_relationships.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "Create recurring issues",
            sql: include_str!("../migrations/0011_recurring_issues.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "Create saved issue views",
            sql: include_str!("../migrations/0012_saved_views.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "Link issues and projects to documents",
            sql: include_str!("../migrations/0013_document_links.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "Archive issues",
            sql: include_str!("../migrations/0014_issue_archive.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "Add local document revision checkpoints",
            sql: include_str!("../migrations/0015_document_revisions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "Add private document image assets",
            sql: include_str!("../migrations/0016_document_assets.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "Organize documents with folders and library metadata",
            sql: include_str!("../migrations/0017_document_library.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "Index workspace document references",
            sql: include_str!("../migrations/0018_document_references.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "Index workspace document text for local search",
            sql: include_str!("../migrations/0019_document_search.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "Add calendars, events, and issue work blocks",
            sql: include_str!("../migrations/0020_scheduling.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "Track the time-zone rules calendar instants use",
            sql: include_str!("../migrations/0021_time_zone_rules.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 22,
            description: "Add recurring events and occurrence exceptions",
            sql: include_str!("../migrations/0022_event_recurrence.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 23,
            description: "Link calendar events to documents and projects",
            sql: include_str!("../migrations/0023_event_links.sql"),
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

/// Returns the open workspace database, or a typed error if it is not ready.
pub async fn pool(instances: &DbInstances) -> Result<SqlitePool, DatabaseError> {
    let instances = instances.0.read().await;
    let Some(DbPool::Sqlite(pool)) = instances.get(DATABASE) else {
        return Err(DatabaseError::DatabaseUnavailable);
    };
    Ok(pool.clone())
}

#[tauri::command]
pub async fn database_status(
    instances: State<'_, DbInstances>,
) -> Result<DatabaseStatus, DatabaseError> {
    let pool = pool(&instances).await?;
    active_workspace(&pool).await.map(DatabaseStatus::from)
}

#[cfg(test)]
mod tests {
    use super::{active_workspace, migrations, DatabaseError, Workspace};
    use crate::test_support::{
        add_workspace, memory_pool, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE,
        OTHER_WORKSPACE,
    };

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
            add_workspace(&pool, OTHER_WORKSPACE, "Existing").await;
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
                    (OTHER_WORKSPACE.into(), "Existing".into()),
                ]
            );
            let applied: Vec<(i64, bool)> =
                sqlx::query_as("SELECT version, success FROM _sqlx_migrations ORDER BY version")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let expected: Vec<(i64, bool)> = migrations()
                .iter()
                .map(|migration| (migration.version, true))
                .collect();
            assert_eq!(applied, expected);
            pool.close().await;
        });
    }

    #[test]
    fn active_workspace_must_reference_an_existing_workspace() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;

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
