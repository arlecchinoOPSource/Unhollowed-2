//! Interrupted writes, forced termination, disk errors, and lock contention
//! (U2-P6-06). Disposable databases only.

use crate::test_support::{migrator, TempDatabase, DEFAULT_WORKSPACE};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::time::Duration;

const INSERT: &str = "INSERT INTO documents (id, workspace_id, title, content, created_at, updated_at) VALUES (?, ?, ?, '{}', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')";
const CHILD: &str = "U2_RECOVERY_CHILD_DB";

async fn titles(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar("SELECT title FROM documents ORDER BY title")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn add(pool: &SqlitePool, title: &str) {
    sqlx::query(INSERT)
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(DEFAULT_WORKSPACE)
        .bind(title)
        .execute(pool)
        .await
        .unwrap();
}

/// Runs only inside the child process started by the termination test. In a
/// normal test run the variable is unset and this does nothing.
#[test]
fn child_writes_then_dies_mid_transaction() {
    let Ok(path) = std::env::var(CHILD) else {
        return;
    };
    tauri::async_runtime::block_on(async {
        let pool = SqlitePool::connect_with(SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
        add(&pool, "committed before the crash").await;
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(INSERT)
            .bind("half")
            .bind(DEFAULT_WORKSPACE)
            .bind("half written")
            .execute(&mut *tx)
            .await
            .unwrap();
        std::process::abort();
    });
}

#[test]
fn a_killed_process_keeps_committed_work_and_drops_the_open_transaction() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("recovery-kill");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        add(&pool, "committed earlier").await;
        let path = pool.connect_options().get_filename().to_path_buf();
        pool.close().await;

        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "recovery_tests::child_writes_then_dies_mid_transaction",
            ])
            .env(CHILD, &path)
            .status()
            .unwrap();
        assert!(!status.success(), "the child must die by abort");

        let pool = database.open().await;
        assert_eq!(
            titles(&pool).await,
            ["committed before the crash", "committed earlier"]
        );
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
        // The database is writable again at once.
        add(&pool, "after recovery").await;
        assert_eq!(titles(&pool).await.len(), 3);
    });
}

#[test]
fn a_dropped_transaction_changes_nothing() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("recovery-rollback");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        add(&pool, "kept").await;
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("DELETE FROM documents")
            .execute(&mut *tx)
            .await
            .unwrap();
        drop(tx);
        assert_eq!(titles(&pool).await, ["kept"]);
    });
}

#[test]
fn a_database_created_like_the_app_uses_write_ahead_logging_with_full_sync() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("recovery-durability");
        let pool = database.open().await;
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        let sync: i64 = sqlx::query_scalar("PRAGMA synchronous")
            .fetch_one(&pool)
            .await
            .unwrap();
        // tauri-plugin-sql creates the file with `create_database`, which
        // turns on write-ahead logging, and sqlx keeps synchronous FULL.
        assert_eq!((mode.as_str(), sync), ("wal", 2));
    });
}

#[test]
fn a_write_refused_by_the_disk_is_an_error_not_a_success() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("recovery-readonly");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        add(&pool, "existing").await;
        pool.close().await;
        let path = database
            .open()
            .await
            .connect_options()
            .get_filename()
            .to_path_buf();
        let read_only =
            SqlitePool::connect_with(SqliteConnectOptions::new().filename(&path).read_only(true))
                .await
                .unwrap();
        let result = sqlx::query(INSERT)
            .bind("x")
            .bind(DEFAULT_WORKSPACE)
            .bind("lost")
            .execute(&read_only)
            .await;
        assert!(result.is_err(), "a refused write must surface as an error");
        assert_eq!(titles(&read_only).await, ["existing"]);
    });
}

#[test]
fn a_locked_database_reports_busy_and_succeeds_once_released() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("recovery-lock");
        let setup = database.open().await;
        migrator(i64::MAX).await.run(&setup).await.unwrap();
        let path = setup.connect_options().get_filename().to_path_buf();
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .busy_timeout(Duration::from_millis(150));
        let holder = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .unwrap();
        let writer = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        let mut hold = holder.acquire().await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *hold)
            .await
            .unwrap();
        let blocked = sqlx::query(INSERT)
            .bind("b")
            .bind(DEFAULT_WORKSPACE)
            .bind("blocked")
            .execute(&writer)
            .await;
        let message = blocked.unwrap_err().to_string();
        assert!(message.contains("locked"), "unexpected error: {message}");
        assert!(
            titles(&setup).await.is_empty(),
            "a blocked write left a row"
        );

        sqlx::query("ROLLBACK").execute(&mut *hold).await.unwrap();
        drop(hold);
        add(&writer, "after release").await;
        assert_eq!(titles(&setup).await, ["after release"]);
    });
}
