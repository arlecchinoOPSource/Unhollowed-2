//! Whole-workspace backup, restore, and upgrade (U2-P6-07). The supported
//! full backup is a copy of the closed database file; this proves that copy
//! is complete and restores exactly, including after an upgrade. Disposable
//! databases only.

use crate::{
    document_links::{self, Owner},
    documents, habits,
    relationships::{self, RelationKind},
    scheduling::{self, recurrence::RepeatRule, EventInput},
    test_support::{add_issue, add_project, migrator, TempDatabase, DEFAULT_WORKSPACE},
};
use serde_json::json;
use sqlx::SqlitePool;

const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// Fills every module the workspace has, linked across modules.
async fn populate(db: &SqlitePool) {
    let workspace = DEFAULT_WORKSPACE;
    let project = add_project(db, workspace, "Release").await;
    let one = add_issue(db, workspace, Some(&project)).await;
    let two = add_issue(db, workspace, Some(&project)).await;
    relationships::add(db, workspace, &one, &two, RelationKind::Blocks)
        .await
        .unwrap();
    let document = documents::create(db, workspace, Some("Notes"))
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO document_assets (id, workspace_id, document_id, mime, bytes)
         VALUES ('image-1', ?, ?, 'image/png', ?)",
    )
    .bind(workspace)
    .bind(&document.id)
    .bind(PNG.to_vec())
    .execute(db)
    .await
    .unwrap();
    document_links::link(db, workspace, Owner::Issue, &one, &document.id)
        .await
        .unwrap();
    scheduling::create_event(
        db,
        workspace,
        EventInput {
            title: "Standup".into(),
            time_zone: Some("Europe/Paris".into()),
            start: Some("2026-11-17T09:00".into()),
            end: Some("2026-11-17T09:15".into()),
            repeat: Some(RepeatRule {
                freq: "daily".into(),
                interval: 1,
                count: Some(5),
                until: None,
            }),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let habit = habits::create(db, workspace, "Walk", Some("2026-11-01"), "2026-11-17")
        .await
        .unwrap();
    habits::set_completion(db, workspace, &habit.id, "2026-11-16", true, "2026-11-17")
        .await
        .unwrap();
    crate::checkins::save(
        db,
        workspace,
        "2026-11-16",
        Some(4),
        Some(3),
        Some(5),
        Some("Good day"),
        "2026-11-17",
    )
    .await
    .unwrap();
    crate::dashboards::save(
        db,
        workspace,
        None,
        "Mine",
        json!({"version": 1,
               "preferences": {"preset": "last30", "custom": {"from": "2026-10-19", "to": "2026-11-17"}},
               "widgets": []}),
    )
    .await
    .unwrap();
}

async fn tables(db: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'document_index%'
         ORDER BY name",
    )
    .fetch_all(db)
    .await
    .unwrap()
}

async fn rows(db: &SqlitePool, schema: &str, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {schema}.\"{table}\""))
        .fetch_one(db)
        .await
        .unwrap()
}

/// Asserts both databases hold the same rows in every table, in both
/// directions, so nothing was dropped, changed, or added.
async fn assert_identical(
    original: &SqlitePool,
    copy_path: &std::path::Path,
) -> Vec<(String, i64)> {
    sqlx::query(&format!(
        "ATTACH DATABASE '{}' AS copy",
        copy_path.display()
    ))
    .execute(original)
    .await
    .unwrap();
    let mut counts = Vec::new();
    for table in tables(original).await {
        let missing: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM (SELECT * FROM main.\"{table}\" EXCEPT SELECT * FROM copy.\"{table}\")"
        ))
        .fetch_one(original)
        .await
        .unwrap();
        let extra: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM (SELECT * FROM copy.\"{table}\" EXCEPT SELECT * FROM main.\"{table}\")"
        ))
        .fetch_one(original)
        .await
        .unwrap();
        assert_eq!((missing, extra), (0, 0), "{table} differs after restore");
        assert_eq!(
            rows(original, "main", &table).await,
            rows(original, "copy", &table).await,
            "{table} row count"
        );
        counts.push((table.clone(), rows(original, "main", &table).await));
    }
    sqlx::query("DETACH DATABASE copy")
        .execute(original)
        .await
        .unwrap();
    counts
}

#[test]
fn a_copy_of_the_closed_database_restores_every_module_exactly() {
    tauri::async_runtime::block_on(async {
        let live = TempDatabase::new("backup-live");
        let db = live.open().await;
        migrator(i64::MAX).await.run(&db).await.unwrap();
        populate(&db).await;
        let path = db.connect_options().get_filename().to_path_buf();
        db.close().await;

        // The backup is the file itself, copied while the app is closed.
        let backup = std::env::temp_dir().join(format!("u2-backup-{}.sqlite3", std::process::id()));
        std::fs::copy(&path, &backup).unwrap();

        // Restore into a fresh disposable environment and compare.
        let restored = TempDatabase::new("backup-restored");
        let restored_db = restored.open().await;
        let restored_path = restored_db.connect_options().get_filename().to_path_buf();
        restored_db.close().await;
        std::fs::copy(&backup, &restored_path).unwrap();
        let restored_db = restored.open().await;
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&restored_db)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
        let broken = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&restored_db)
            .await
            .unwrap();
        assert!(broken.is_empty());
        // ATTACH is per connection, so compare through a single-connection pool.
        let original = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
        let counts = assert_identical(&original, &restored_path).await;

        // Every module the backup claims to cover really held data.
        for table in [
            "projects",
            "issues",
            "issue_relationships",
            "documents",
            "document_assets",
            "issue_documents",
            "events",
            "habits",
            "habit_completions",
            "daily_checkins",
            "dashboards",
        ] {
            let count = counts.iter().find(|(name, _)| name == table).unwrap().1;
            assert!(count > 0, "{table} was empty, so the test proved nothing");
        }

        // The restored copy opens with the app's migrations, keeps working, and
        // a second restore over the same file changes nothing.
        migrator(i64::MAX).await.run(&restored_db).await.unwrap();
        add_issue(&restored_db, DEFAULT_WORKSPACE, None).await;
        let _ = std::fs::remove_file(&backup);
    });
}

#[test]
fn a_backup_from_an_older_release_upgrades_without_losing_a_row() {
    tauri::async_runtime::block_on(async {
        let live = TempDatabase::new("backup-older");
        let db = live.open().await;
        migrator(5).await.run(&db).await.unwrap();
        let project = add_project(&db, DEFAULT_WORKSPACE, "Old project").await;
        let issue =
            crate::test_support::add_issue_before_upgrade(&db, DEFAULT_WORKSPACE, Some(&project))
                .await;
        db.close().await;

        // "Install the new version": open the old file and run its migrations.
        let db = live.open().await;
        migrator(i64::MAX).await.run(&db).await.unwrap();
        let kept: (String, Option<String>) =
            sqlx::query_as("SELECT id, project_id FROM issues WHERE id = ?")
                .bind(&issue)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(kept, (issue, Some(project)));
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
    });
}

#[test]
fn an_older_app_refuses_a_newer_database_without_touching_it() {
    tauri::async_runtime::block_on(async {
        let live = TempDatabase::new("backup-newer");
        let db = live.open().await;
        migrator(i64::MAX).await.run(&db).await.unwrap();
        populate(&db).await;
        let before = rows(&db, "main", "issues").await;
        // An app that only knows migrations up to 10 opens the same file.
        let refused = migrator(10).await.run(&db).await;
        assert!(
            refused.is_err(),
            "an older app must not accept a newer file"
        );
        assert_eq!(rows(&db, "main", "issues").await, before);
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
    });
}

const CRASH_CHILD: &str = "U2_BACKUP_CRASH_CHILD_DB";

/// Runs only in the child process of the test below: commits one issue and
/// dies without closing the database, as a crash or forced quit would.
#[test]
fn child_commits_then_dies_without_closing() {
    let Ok(path) = std::env::var(CRASH_CHILD) else {
        return;
    };
    tauri::async_runtime::block_on(async {
        let pool = sqlx::SqlitePool::connect(&format!("sqlite:{path}"))
            .await
            .unwrap();
        add_issue(&pool, DEFAULT_WORKSPACE, None).await;
        std::process::abort();
    });
}

/// The database is in write-ahead logging mode, so after a crash the newest
/// committed work can sit in the `-wal` file next to the main file. A backup
/// of the main file alone would miss it.
#[test]
fn after_a_crash_only_a_copy_of_all_database_files_keeps_the_last_commits() {
    tauri::async_runtime::block_on(async {
        let live = TempDatabase::new("backup-crash");
        let db = live.open().await;
        migrator(i64::MAX).await.run(&db).await.unwrap();
        let path = db.connect_options().get_filename().to_path_buf();
        db.close().await;

        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "backup_tests::child_commits_then_dies_without_closing",
            ])
            .env(CRASH_CHILD, &path)
            .status()
            .unwrap();
        assert!(!status.success(), "the child must die by abort");
        let wal = {
            let mut name = path.clone().into_os_string();
            name.push("-wal");
            std::path::PathBuf::from(name)
        };
        assert!(
            wal.metadata().unwrap().len() > 0,
            "the commit is in the -wal file"
        );

        let copies = std::env::temp_dir().join(format!("u2-crash-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&copies);
        std::fs::create_dir_all(&copies).unwrap();
        let count = |dir: &std::path::Path| {
            let file = dir.join("workspace.sqlite3");
            async move {
                let pool = SqlitePool::connect(&format!("sqlite:{}", file.display()))
                    .await
                    .unwrap();
                let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM issues")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                pool.close().await;
                rows
            }
        };

        let main_only = copies.join("main-only");
        std::fs::create_dir_all(&main_only).unwrap();
        std::fs::copy(&path, main_only.join("workspace.sqlite3")).unwrap();
        assert_eq!(
            count(&main_only).await,
            0,
            "the main file alone misses the commit"
        );

        let all = copies.join("all-files");
        std::fs::create_dir_all(&all).unwrap();
        std::fs::copy(&path, all.join("workspace.sqlite3")).unwrap();
        std::fs::copy(&wal, all.join("workspace.sqlite3-wal")).unwrap();
        assert_eq!(count(&all).await, 1, "main file plus -wal keeps the commit");
        let _ = std::fs::remove_dir_all(&copies);
    });
}
