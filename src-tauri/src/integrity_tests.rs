//! Database integrity and migration audit (U2-P6-05). Every test uses a
//! disposable database; none touches a real workspace.

use crate::test_support::{
    add_issue_before_upgrade, add_project, add_workspace, memory_pool, migrated_pool, migrator,
    TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};
use sqlx::SqlitePool;

/// FNV-1a 64 of each shipped migration with line endings normalized. A
/// shipped migration must never change: users' databases already ran it. Add
/// a row for a new file; never edit an existing row.
const SHIPPED: &[(&str, u64)] = &[
    ("0001_workspace.sql", 0x9bc023a17e231a40),
    ("0002_active_workspace.sql", 0x4f76605b85041237),
    ("0003_documents.sql", 0x2e01d86a65645b79),
    ("0004_projects.sql", 0x099b11a615c431ee),
    ("0005_issues.sql", 0x599c7f959e287306),
    ("0006_issue_search.sql", 0x8e48d70a41a4975c),
    ("0007_labels.sql", 0xb59ac0ff7d784b3f),
    ("0008_milestones.sql", 0x1fc6e02450bc9e99),
    ("0009_project_goals.sql", 0xbff6cc683cb9d86d),
    ("0010_issue_relationships.sql", 0x072f7bfcd2cb3533),
    ("0011_recurring_issues.sql", 0x1eedac5e9dee2f79),
    ("0012_saved_views.sql", 0x9e2286c6d78a8a47),
    ("0013_document_links.sql", 0x24045f347b94c192),
    ("0014_issue_archive.sql", 0x2ac389870bedfab2),
    ("0015_document_revisions.sql", 0x75fa48d6507c00f5),
    ("0016_document_assets.sql", 0xc90e9dfbb4da98b1),
    ("0017_document_library.sql", 0x46e021f00c7260de),
    ("0018_document_references.sql", 0x50bcd8fe1929785a),
    ("0019_document_search.sql", 0x0d24437af4d7a780),
    ("0020_scheduling.sql", 0x1d41344e8268299d),
    ("0021_time_zone_rules.sql", 0x8e2013942993eda4),
    ("0022_event_recurrence.sql", 0xdeca1b2fd2f854fb),
    ("0023_event_links.sql", 0xfb47ba7a65489025),
    ("0024_event_reminders.sql", 0x548ef84d9e47e582),
    ("0025_event_ics_uid.sql", 0xea7f1cad1ec4f255),
    ("0026_habits.sql", 0x224e28c840937419),
    ("0027_daily_checkins.sql", 0x159e669e5e55093d),
    ("0028_habit_routines.sql", 0x3baba135b6823360),
    ("0029_dashboards.sql", 0x560e201acebcd0e3),
];

fn fnv(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes.iter().filter(|byte| **byte != b'\r') {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

async fn assert_healthy(pool: &SqlitePool, context: &str) {
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(integrity, "ok", "integrity_check after {context}");
    let broken = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await
        .unwrap();
    assert!(broken.is_empty(), "foreign_key_check after {context}");
}

#[test]
fn shipped_migrations_are_never_edited_and_every_file_is_listed() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/migrations");
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".sql"))
        .collect();
    files.sort();
    let listed: Vec<&str> = SHIPPED.iter().map(|(name, _)| *name).collect();
    assert_eq!(files, listed, "add new migration files to SHIPPED");
    for (name, expected) in SHIPPED {
        let bytes = std::fs::read(format!("{dir}/{name}")).unwrap();
        assert_eq!(fnv(&bytes), *expected, "{name} was edited after shipping");
    }
}

#[test]
fn a_fresh_database_is_consistent_and_enforces_foreign_keys() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        assert_healthy(&pool, "a fresh migration").await;
        let enforced: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(enforced, 1, "foreign keys must be enforced");
        let orphan = sqlx::query(
            "INSERT INTO issues (id, workspace_id, number, title, description)
             VALUES ('x', 'no-such-workspace', 1, 't', '{}')",
        )
        .execute(&pool)
        .await;
        assert!(orphan.is_err(), "an issue needs an existing workspace");
    });
}

/// Every table that stores user records carries `workspace_id`. The tables
/// below do not, and each is reached only through a parent that does.
#[test]
fn only_known_child_and_index_tables_lack_a_workspace_column() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT m.name FROM sqlite_master m
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '\\_sqlx%' ESCAPE '\\'
               AND NOT EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'workspace_id')
             ORDER BY m.name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let expected = [
            "app_state",
            "document_index",
            "document_index_config",
            "document_index_content",
            "document_index_data",
            "document_index_docsize",
            "document_index_ids",
            "document_index_idx",
            "event_exceptions",
            "missions",
            "objective_issues",
            "objectives",
            "workspaces",
        ];
        assert_eq!(
            tables, expected,
            "review workspace scoping of any new table"
        );
    });
}

#[test]
fn every_upgrade_step_keeps_ids_relationships_and_integrity() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("integrity-upgrade-steps");
        let pool = database.open().await;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        migrator(5).await.run(&pool).await.unwrap();
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Kept").await;
        let issue = add_issue_before_upgrade(&pool, DEFAULT_WORKSPACE, Some(&project)).await;
        let other = add_issue_before_upgrade(&pool, OTHER_WORKSPACE, None).await;

        let last = migrator(i64::MAX).await.migrations.last().unwrap().version;
        for version in 6..=last {
            migrator(version).await.run(&pool).await.unwrap();
            assert_healthy(&pool, &format!("migration {version}")).await;
            let kept: (String, Option<String>, String) =
                sqlx::query_as("SELECT id, project_id, workspace_id FROM issues WHERE id = ?")
                    .bind(&issue)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                kept,
                (
                    issue.clone(),
                    Some(project.clone()),
                    DEFAULT_WORKSPACE.into()
                ),
                "issue changed at migration {version}"
            );
        }
        let counts: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM issues), (SELECT count(*) FROM projects),
                    (SELECT count(*) FROM issues WHERE id = ? AND workspace_id = ?)",
        )
        .bind(&other)
        .bind(OTHER_WORKSPACE)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(counts, (2, 1, 1), "no record added, lost, or moved");

        // Reopening runs no migration again and changes nothing.
        pool.close().await;
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_healthy(&pool, "a reopen").await;
        let again: i64 = sqlx::query_scalar("SELECT count(*) FROM issues")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(again, 2);
    });
}

#[test]
fn a_failing_migration_rolls_back_completely_and_is_not_recorded() {
    tauri::async_runtime::block_on(async {
        let dir = std::env::temp_dir().join(format!("u2-bad-migration-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("0001_ok.sql"), "CREATE TABLE kept (id TEXT);").unwrap();
        std::fs::write(
            dir.join("0002_bad.sql"),
            "CREATE TABLE half_done (id TEXT); INSERT INTO missing_table VALUES (1);",
        )
        .unwrap();
        let pool = memory_pool().await;
        let migrator = sqlx::migrate::Migrator::new(dir.as_path()).await.unwrap();
        assert!(migrator.run(&pool).await.is_err());
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('kept', 'half_done')",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            tables,
            ["kept"],
            "the failed migration left a partial table"
        );
        let recorded: Vec<i64> =
            sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(recorded, [1], "only the successful migration is recorded");
        let _ = std::fs::remove_dir_all(&dir);
    });
}
