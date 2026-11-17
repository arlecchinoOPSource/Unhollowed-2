//! Ember backup import: the F2 fixture from docs/HABITS.md, unsupported and
//! invalid files, collisions, preview drift, rollback, and workspace scope.
//! All data is synthetic.

use super::import::{run, ImportReport, MAX_BYTES};
use super::{archive, create, history, list, HabitError};
use crate::test_support::{add_workspace, migrated_pool, DEFAULT_WORKSPACE, OTHER_WORKSPACE};
use serde_json::{json, Value};
use sqlx::SqlitePool;

const WS: &str = DEFAULT_WORKSPACE;
const WALK: &str = "fedcba9876543210fedcba9876543210";
const RETIRED: &str = "00000000000000000000000000000001";
const READ: &str = "0123456789abcdef0123456789abcdef";

fn backup() -> Value {
    json!({
        "format": "ember-backup",
        "version": 1,
        "habits": [
            { "id": WALK, "name": "Synthetic walk", "sortOrder": 0,
              "startDate": "2028-01-01", "archivedAt": null },
            { "id": RETIRED, "name": "Synthetic retired", "sortOrder": 1,
              "startDate": "2027-12-01", "archivedAt": "2028-01-15" },
            { "id": READ, "name": "Synthetic read", "sortOrder": 2,
              "startDate": "2028-02-01", "archivedAt": null },
        ],
        "completions": [
            [RETIRED, "2028-01-10"], [READ, "2028-02-28"], [READ, "2028-02-29"],
        ],
    })
}

async fn preview(pool: &SqlitePool, content: &str) -> ImportReport {
    run(pool, WS, content, None).await.unwrap()
}

async fn counts(pool: &SqlitePool) -> (i64, i64) {
    let habits = sqlx::query_scalar("SELECT count(*) FROM habits")
        .fetch_one(pool)
        .await
        .unwrap();
    let completions = sqlx::query_scalar("SELECT count(*) FROM habit_completions")
        .fetch_one(pool)
        .await
        .unwrap();
    (habits, completions)
}

#[test]
fn imports_habits_order_archives_and_completions_after_a_matching_preview() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        create(&pool, WS, "Existing", Some("2028-01-01"), "2028-03-01")
            .await
            .unwrap();
        let content = backup().to_string();

        let seen = preview(&pool, &content).await;
        assert_eq!(seen.fatal, None);
        assert!(!seen.applied);
        assert_eq!((seen.habits.len(), seen.completions), (3, 3));
        // The preview ran every step, then rolled back.
        assert_eq!(counts(&pool).await, (1, 0));

        let done = run(&pool, WS, &content, Some(&seen.token)).await.unwrap();
        assert!(done.applied);
        assert_eq!(
            (done.habits, done.completions),
            (seen.habits, seen.completions)
        );

        let habits = list(&pool, WS).await.unwrap();
        let summary: Vec<_> = habits
            .iter()
            .map(|h| (h.name.as_str(), h.position, h.archived_on.as_deref()))
            .collect();
        assert_eq!(
            summary,
            [
                ("Existing", 0, None),
                ("Synthetic walk", 1, None),
                ("Synthetic retired", 2, Some("2028-01-15")),
                ("Synthetic read", 3, None),
            ]
        );
        let sources: Vec<_> = habits.iter().map(|h| h.source_id.as_deref()).collect();
        assert_eq!(sources, [None, Some(WALK), Some(RETIRED), Some(READ)]);
        assert!(habits[1..]
            .iter()
            .all(|h| h.source.as_deref() == Some("ember")));
        // New IDs, not Ember's.
        assert!(habits.iter().all(|h| h.id.len() == 36));
        assert_eq!(
            history(&pool, WS, &habits[2].id).await.unwrap(),
            ["2028-01-10"]
        );
        assert_eq!(
            history(&pool, WS, &habits[3].id).await.unwrap(),
            ["2028-02-28", "2028-02-29"]
        );
        assert_eq!(counts(&pool).await, (4, 3));

        // The same backup again is a repeat, named, and changes nothing.
        let again = preview(&pool, &content).await;
        let message = again.fatal.unwrap();
        assert!(message.contains("Already imported"));
        assert_eq!(again.conflicts.len(), 3);
        let forced = run(&pool, WS, &content, Some("anything")).await.unwrap();
        assert!(forced.fatal.is_some() && !forced.applied);
        assert_eq!(counts(&pool).await, (4, 3));
    });
}

#[test]
fn unsupported_and_unreadable_files_are_refused_without_writes() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let mut newer = backup();
        newer["version"] = json!(2);
        let mut other_format = backup();
        other_format["format"] = json!("something-else");
        let mut zero = backup();
        zero["version"] = json!(0);
        let mut extra = backup();
        extra["extra"] = json!(true);
        let mut extra_habit_field = backup();
        extra_habit_field["habits"][0]["color"] = json!("red");
        let too_big = " ".repeat(MAX_BYTES + 1);
        let cases: Vec<(String, &str)> = vec![
            (newer.to_string(), "newer Ember (version 2)"),
            (other_format.to_string(), "not an Ember desktop backup"),
            (zero.to_string(), "version is not supported"),
            (extra.to_string(), "not valid"),
            (extra_habit_field.to_string(), "not valid"),
            (
                json!({ "encoding": "daily-bitmask-v1", "schemaVersion": 1 }).to_string(),
                "website snapshot",
            ),
            ("not json".into(), "not a JSON file"),
            ("[1, 2]".into(), "not an Ember backup"),
            (String::new(), "not a JSON file"),
            (too_big, "32 MiB"),
        ];
        for (content, expected) in cases {
            let report = preview(&pool, &content).await;
            let message = report
                .fatal
                .unwrap_or_else(|| panic!("accepted: {expected}"));
            assert!(message.contains(expected), "{message} lacks {expected}");
            assert!(report.habits.is_empty() && !report.applied);
            let forced = run(&pool, WS, &content, Some("token")).await.unwrap();
            assert!(forced.fatal.is_some() && !forced.applied);
        }
        assert_eq!(counts(&pool).await, (0, 0));
    });
}

#[test]
fn invalid_content_is_refused_with_a_reason_and_no_partial_writes() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let mut cases: Vec<(Value, &str)> = Vec::new();
        let mut case = |change: &dyn Fn(&mut Value), expected: &'static str| {
            let mut value = backup();
            change(&mut value);
            cases.push((value, expected));
        };
        case(
            &|b| {
                let mut copy = b["habits"][0].clone();
                copy["sortOrder"] = json!(9);
                copy["name"] = json!("Copy");
                b["habits"].as_array_mut().unwrap().push(copy);
            },
            "repeats a habit",
        );
        case(
            &|b| b["habits"][1]["sortOrder"] = json!(0),
            "repeats a habit",
        );
        case(
            &|b| b["habits"][0]["sortOrder"] = json!(-1),
            "repeats a habit",
        );
        case(
            &|b| b["habits"][1]["archivedAt"] = json!("2027-11-30"),
            "archived before it started",
        );
        case(
            &|b| b["habits"][0]["startDate"] = json!("2027-02-29"),
            "not a valid calendar date",
        );
        case(
            &|b| b["habits"][2]["startDate"] = json!("2028-2-1"),
            "not a valid calendar date",
        );
        case(&|b| b["habits"][0]["id"] = json!("ABC"), "invalid ID");
        case(&|b| b["habits"][0]["name"] = json!("   "), "1 to 60");
        case(
            &|b| b["habits"][0]["name"] = json!("x".repeat(61)),
            "1 to 60",
        );
        case(
            &|b| b["habits"][2]["name"] = json!("synthetic WALK"),
            "Two active habits",
        );
        case(
            &|b| {
                b["completions"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!([RETIRED, "2028-01-16"]))
            },
            "outside its active days",
        );
        case(
            &|b| {
                b["completions"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!([WALK, "2027-12-31"]))
            },
            "outside its active days",
        );
        case(
            &|b| {
                b["completions"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!([READ, "2028-02-28"]))
            },
            "repeated completion",
        );
        case(
            &|b| {
                b["completions"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(["ffffffffffffffffffffffffffffffff", "2028-01-01"]))
            },
            "not in the file",
        );
        case(
            &|b| {
                b["completions"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!([WALK, "2028-13-01"]))
            },
            "not a valid calendar date",
        );
        for (value, expected) in &cases {
            let content = value.to_string();
            let message = preview(&pool, &content)
                .await
                .fatal
                .unwrap_or_else(|| panic!("accepted: {expected}"));
            assert!(message.contains(expected), "{message} lacks {expected}");
            let forced = run(&pool, WS, &content, Some("token")).await.unwrap();
            assert!(forced.fatal.is_some() && !forced.applied);
        }
        assert_eq!(counts(&pool).await, (0, 0));
    });
}

#[test]
fn the_habit_limit_is_enforced() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let habits: Vec<Value> = (0..1001)
            .map(|i| {
                json!({ "id": format!("{i:032x}"), "name": format!("Habit {i}"),
                        "sortOrder": i, "startDate": "2028-01-01", "archivedAt": null })
            })
            .collect();
        let content = json!({
            "format": "ember-backup", "version": 1, "habits": habits, "completions": []
        })
        .to_string();
        assert!(preview(&pool, &content)
            .await
            .fatal
            .unwrap()
            .contains("1000"));
        assert_eq!(counts(&pool).await, (0, 0));
    });
}

#[test]
fn same_name_with_a_different_id_is_never_merged() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let mine = create(
            &pool,
            WS,
            "synthetic walk",
            Some("2028-01-01"),
            "2028-03-01",
        )
        .await
        .unwrap();
        let content = backup().to_string();
        let report = preview(&pool, &content).await;
        let message = report.fatal.unwrap();
        assert!(message.contains("never merged by name"));
        assert_eq!(report.conflicts, ["Synthetic walk"]);
        assert_eq!(counts(&pool).await, (1, 0));

        // Once the local habit is archived the name is free again.
        archive(&pool, WS, &mine.id, "2028-03-01").await.unwrap();
        let ready = preview(&pool, &content).await;
        assert_eq!(ready.fatal, None);
        run(&pool, WS, &content, Some(&ready.token)).await.unwrap();
        assert_eq!(counts(&pool).await, (4, 3));
        assert_eq!(list(&pool, WS).await.unwrap()[0].name, "synthetic walk");
    });
}

#[test]
fn an_archived_incoming_habit_may_share_a_name_with_an_active_one() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        create(
            &pool,
            WS,
            "Synthetic retired",
            Some("2028-01-01"),
            "2028-03-01",
        )
        .await
        .unwrap();
        let content = backup().to_string();
        let report = preview(&pool, &content).await;
        assert_eq!(report.fatal, None);
        run(&pool, WS, &content, Some(&report.token)).await.unwrap();
        assert_eq!(counts(&pool).await, (4, 3));
    });
}

#[test]
fn a_changed_workspace_or_file_invalidates_the_preview() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let content = backup().to_string();
        let seen = preview(&pool, &content).await;

        // A habit appears between the preview and the import.
        create(&pool, WS, "Unrelated", Some("2028-01-01"), "2028-03-01")
            .await
            .unwrap();
        let stale = run(&pool, WS, &content, Some(&seen.token)).await.unwrap();
        assert!(stale.fatal.unwrap().contains("changed since the preview"));
        assert!(!stale.applied);
        assert_eq!(counts(&pool).await, (1, 0));

        // A different file cannot reuse another file's preview.
        let fresh = preview(&pool, &content).await;
        assert_ne!(fresh.token, seen.token);
        let mut other = backup();
        other["habits"][0]["name"] = json!("Renamed walk");
        let wrong = run(&pool, WS, &other.to_string(), Some(&fresh.token))
            .await
            .unwrap();
        assert!(wrong.fatal.is_some());
        assert_eq!(counts(&pool).await, (1, 0));

        let done = run(&pool, WS, &content, Some(&fresh.token)).await.unwrap();
        assert!(done.applied);
        assert_eq!(counts(&pool).await, (4, 3));
    });
}

#[test]
fn a_failure_midway_rolls_back_every_row() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let content = backup().to_string();
        let seen = preview(&pool, &content).await;
        sqlx::query(
            "CREATE TRIGGER fail_import BEFORE INSERT ON habit_completions
             BEGIN SELECT RAISE(ABORT, 'test'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Habits are written before completions, so this fails after inserts.
        assert_eq!(
            run(&pool, WS, &content, Some(&seen.token)).await,
            Err(HabitError::StorageFailed)
        );
        assert_eq!(counts(&pool).await, (0, 0));
        // A failed preview also leaves nothing behind.
        assert_eq!(
            run(&pool, WS, &content, None).await,
            Err(HabitError::StorageFailed)
        );
        assert_eq!(counts(&pool).await, (0, 0));
    });
}

#[test]
fn imports_are_scoped_to_the_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let content = backup().to_string();
        let first = preview(&pool, &content).await;
        run(&pool, WS, &content, Some(&first.token)).await.unwrap();

        // Another workspace has no repeat or name conflict with the first.
        let other = run(&pool, OTHER_WORKSPACE, &content, None).await.unwrap();
        assert_eq!(other.fatal, None);
        run(&pool, OTHER_WORKSPACE, &content, Some(&other.token))
            .await
            .unwrap();
        assert_eq!(counts(&pool).await, (6, 6));
        assert_eq!(list(&pool, OTHER_WORKSPACE).await.unwrap().len(), 3);
        assert_eq!(list(&pool, WS).await.unwrap().len(), 3);
    });
}
