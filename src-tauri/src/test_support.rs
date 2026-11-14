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

    pub async fn open(&self) -> SqlitePool {
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
