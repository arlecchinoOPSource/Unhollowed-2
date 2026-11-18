//! Helpers for tests that need disposable SQLite databases.

use sqlx::{
    migrate::Migrator,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use std::path::{Path, PathBuf};

pub const DEFAULT_WORKSPACE: &str = "00000000-0000-4000-8000-000000000001";
pub const OTHER_WORKSPACE: &str = "00000000-0000-4000-8000-000000000002";

/// Loads the migration files and keeps only versions up to `up_to`, which
/// reproduces the schema an older release would have created.
pub async fn migrator(up_to: i64) -> Migrator {
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

pub async fn memory_pool() -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap()
}

/// An in-memory database with every migration applied.
pub async fn migrated_pool() -> SqlitePool {
    let pool = memory_pool().await;
    migrator(i64::MAX).await.run(&pool).await.unwrap();
    pool
}

pub async fn add_workspace(pool: &SqlitePool, id: &str, name: &str) {
    sqlx::query("INSERT INTO workspaces (id, name) VALUES (?, ?)")
        .bind(id)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
}

/// A disposable on-disk database that is removed when the test ends.
pub struct TempDatabase(PathBuf);

impl TempDatabase {
    pub fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "unhollowed-2-{name}-{}.sqlite3",
            std::process::id()
        ));
        let database = Self(path);
        database.remove();
        database
    }

    /// Opens the file the way the app does. tauri-plugin-sql creates a new
    /// database with `sqlx::Sqlite::create_database`, which switches it to
    /// write-ahead logging (a setting stored in the file), so a test database
    /// is created the same way and has the same journal mode as a real one.
    pub async fn open(&self) -> SqlitePool {
        use sqlx::migrate::MigrateDatabase;
        if !self.0.exists() {
            sqlx::Sqlite::create_database(&format!("sqlite:{}", self.0.display()))
                .await
                .unwrap();
        }
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

pub async fn add_project(pool: &SqlitePool, workspace: &str, name: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO projects (id, workspace_id, name) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(workspace)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    id
}

pub async fn add_issue(pool: &SqlitePool, workspace: &str, project: Option<&str>) -> String {
    crate::issues::create(
        pool,
        workspace,
        crate::issues::IssueFields {
            title: "Sample issue".into(),
            ..Default::default()
        },
        project,
    )
    .await
    .unwrap()
    .summary
    .id
}

/// Inserts an issue using only the columns of migration 5, for tests that
/// seed data before upgrading. `crate::issues::create` returns columns from
/// the newest migrations, so it cannot run against an older schema.
pub async fn add_issue_before_upgrade(
    pool: &SqlitePool,
    workspace: &str,
    project: Option<&str>,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let number: i64 = sqlx::query_scalar(
        "INSERT INTO issue_counters (workspace_id, last_number) VALUES (?, 1)
         ON CONFLICT (workspace_id) DO UPDATE SET last_number = last_number + 1
         RETURNING last_number",
    )
    .bind(workspace)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO issues (id, workspace_id, number, project_id, title, description)
         VALUES (?, ?, ?, ?, 'Sample issue', '{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\"}]}')",
    )
    .bind(&id)
    .bind(workspace)
    .bind(number)
    .bind(project)
    .execute(pool)
    .await
    .unwrap();
    id
}
