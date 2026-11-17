//! Migration 0026: what the schema itself guarantees, independent of the
//! commands that write it.

use crate::test_support::{
    add_issue_before_upgrade, add_workspace, migrated_pool, migrator, TempDatabase,
    DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};
use sqlx::SqlitePool;

const BEFORE_HABITS: i64 = 25;

async fn add_habit(
    pool: &SqlitePool,
    workspace: &str,
    name: &str,
    position: i64,
    start: &str,
    archived_on: Option<&str>,
) -> Result<String, sqlx::Error> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO habits (id, workspace_id, name, name_key, position, start_date, archived_on)
         VALUES (?, ?, ?, lower(trim(?)), ?, ?, ?)",
    )
    .bind(&id)
    .bind(workspace)
    .bind(name)
    .bind(name)
    .bind(position)
    .bind(start)
    .bind(archived_on)
    .execute(pool)
    .await?;
    Ok(id)
}

async fn complete(
    pool: &SqlitePool,
    workspace: &str,
    habit: &str,
    date: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO habit_completions (habit_id, workspace_id, date) VALUES (?, ?, ?)")
        .bind(habit)
        .bind(workspace)
        .bind(date)
        .execute(pool)
        .await
        .map(|_| ())
}

async fn dates(pool: &SqlitePool, habit: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT date FROM habit_completions WHERE habit_id = ? ORDER BY date")
        .bind(habit)
        .fetch_all(pool)
        .await
        .unwrap()
}

#[test]
fn fresh_workspace_starts_empty() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let habits: i64 = sqlx::query_scalar("SELECT count(*) FROM habits")
            .fetch_one(&pool)
            .await
            .unwrap();
        let completions: i64 = sqlx::query_scalar("SELECT count(*) FROM habit_completions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!((habits, completions), (0, 0));
    });
}

#[test]
fn upgrade_keeps_existing_data_and_habits_survive_reopen() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("habits-upgrade");
        let pool = database.open().await;
        migrator(BEFORE_HABITS).await.run(&pool).await.unwrap();
        let issue = add_issue_before_upgrade(&pool, DEFAULT_WORKSPACE, None).await;
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let kept: String = sqlx::query_scalar("SELECT title FROM issues WHERE id = ?")
            .bind(&issue)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(kept, "Sample issue");
        let habit = add_habit(&pool, DEFAULT_WORKSPACE, "Walk", 0, "2028-02-01", None)
            .await
            .unwrap();
        complete(&pool, DEFAULT_WORKSPACE, &habit, "2028-02-29")
            .await
            .unwrap();
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(dates(&pool, &habit).await, ["2028-02-29"]);
        pool.close().await;
    });
}

#[test]
fn dates_must_be_real_calendar_days() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for bad in [
            "2027-02-29",
            "2026-13-01",
            "2026-11-31",
            "2026-1-01",
            "2026-11-01 ",
            "2026-11-01T00:00",
            "tomorrow",
            "",
        ] {
            assert!(
                add_habit(&pool, DEFAULT_WORKSPACE, "Bad", 0, bad, None)
                    .await
                    .is_err(),
                "start {bad:?} was accepted"
            );
        }
        let habit = add_habit(&pool, DEFAULT_WORKSPACE, "Read", 0, "2000-02-29", None)
            .await
            .unwrap();
        for bad in ["2100-02-29", "2026-02-30", "26-11-01"] {
            assert!(
                complete(&pool, DEFAULT_WORKSPACE, &habit, bad)
                    .await
                    .is_err(),
                "completion {bad:?} was accepted"
            );
        }
        complete(&pool, DEFAULT_WORKSPACE, &habit, "2028-02-29")
            .await
            .unwrap();
        // The archive day may equal the start (inclusive) but never precede it.
        assert!(add_habit(
            &pool,
            DEFAULT_WORKSPACE,
            "Early",
            1,
            "2026-11-05",
            Some("2026-11-04")
        )
        .await
        .is_err());
        add_habit(
            &pool,
            DEFAULT_WORKSPACE,
            "Same day",
            1,
            "2026-11-05",
            Some("2026-11-05"),
        )
        .await
        .unwrap();
    });
}

#[test]
fn duplicates_are_refused() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let habit = add_habit(&pool, DEFAULT_WORKSPACE, "Walk", 0, "2026-11-01", None)
            .await
            .unwrap();
        complete(&pool, DEFAULT_WORKSPACE, &habit, "2026-11-02")
            .await
            .unwrap();
        assert!(complete(&pool, DEFAULT_WORKSPACE, &habit, "2026-11-02")
            .await
            .is_err());
        // One position per workspace, archived habits included.
        assert!(
            add_habit(&pool, DEFAULT_WORKSPACE, "Read", 0, "2026-11-01", None)
                .await
                .is_err()
        );
        // Active names are unique ignoring case; an archived habit may share one.
        assert!(
            add_habit(&pool, DEFAULT_WORKSPACE, " walk ", 1, "2026-11-01", None)
                .await
                .is_err()
        );
        add_habit(
            &pool,
            DEFAULT_WORKSPACE,
            "Walk",
            1,
            "2026-10-01",
            Some("2026-10-31"),
        )
        .await
        .unwrap();
        // The same position and name are free in another workspace.
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        add_habit(&pool, OTHER_WORKSPACE, "Walk", 0, "2026-11-01", None)
            .await
            .unwrap();
        // A source needs its ID, and one source ID appears once per workspace.
        let imported = |position: i64, source: Option<&'static str>, id: Option<&'static str>| {
            sqlx::query(
                "INSERT INTO habits (id, workspace_id, name, name_key, position, start_date, source, source_id)
                 VALUES (?, ?, 'Imported', 'imported', ?, '2026-11-01', ?, ?)",
            )
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(DEFAULT_WORKSPACE)
            .bind(position)
            .bind(source)
            .bind(id)
            .execute(&pool)
        };
        assert!(imported(5, Some("ember"), None).await.is_err());
        assert!(imported(5, None, Some("00000000000000000000000000000001"))
            .await
            .is_err());
        assert!(imported(5, Some("website"), Some("x")).await.is_err());
        imported(5, Some("ember"), Some("00000000000000000000000000000001"))
            .await
            .unwrap();
        sqlx::query("UPDATE habits SET archived_on = '2026-11-01' WHERE position = 5")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            imported(6, Some("ember"), Some("00000000000000000000000000000001"))
                .await
                .is_err()
        );
    });
}

#[test]
fn cross_workspace_writes_and_orphans_are_refused() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let habit = add_habit(&pool, DEFAULT_WORKSPACE, "Walk", 0, "2026-11-01", None)
            .await
            .unwrap();
        assert!(complete(&pool, OTHER_WORKSPACE, &habit, "2026-11-02")
            .await
            .is_err());
        assert!(complete(&pool, DEFAULT_WORKSPACE, "missing", "2026-11-02")
            .await
            .is_err());
        assert!(add_habit(&pool, "missing", "Walk", 0, "2026-11-01", None)
            .await
            .is_err());
        assert!(
            sqlx::query("UPDATE habits SET workspace_id = ? WHERE id = ?")
                .bind(OTHER_WORKSPACE)
                .bind(&habit)
                .execute(&pool)
                .await
                .is_err()
        );
        complete(&pool, DEFAULT_WORKSPACE, &habit, "2026-11-02")
            .await
            .unwrap();
        assert!(
            sqlx::query("UPDATE habit_completions SET workspace_id = ? WHERE habit_id = ?")
                .bind(OTHER_WORKSPACE)
                .bind(&habit)
                .execute(&pool)
                .await
                .is_err()
        );
        // A workspace that still owns habits cannot be deleted.
        assert!(sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .is_err());
    });
}

#[test]
fn archiving_keeps_identity_and_history_and_deletion_takes_completions() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let habit = add_habit(&pool, DEFAULT_WORKSPACE, "Walk", 0, "2026-11-01", None)
            .await
            .unwrap();
        for date in ["2026-11-01", "2026-11-12"] {
            complete(&pool, DEFAULT_WORKSPACE, &habit, date)
                .await
                .unwrap();
        }
        sqlx::query("UPDATE habits SET archived_on = '2026-11-12' WHERE id = ?")
            .bind(&habit)
            .execute(&pool)
            .await
            .unwrap();
        let (id, position): (String, i64) =
            sqlx::query_as("SELECT id, position FROM habits WHERE name = 'Walk'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((id.as_str(), position), (habit.as_str(), 0));
        assert_eq!(dates(&pool, &habit).await, ["2026-11-01", "2026-11-12"]);

        sqlx::query("DELETE FROM habits WHERE id = ?")
            .bind(&habit)
            .execute(&pool)
            .await
            .unwrap();
        assert!(dates(&pool, &habit).await.is_empty());
    });
}
