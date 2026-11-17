//! Habit backup, restore, undo, and exports: fidelity, the required
//! pre-restore copy, stale and invalid input, rollback, and CSV safety.
//! All data is synthetic.

use super::backup::{backup_json, history as export_history, restore, undo, RestoreReport};
use super::{archive, create, history, list, set_completion, HabitError};
use crate::test_support::{add_workspace, migrated_pool, DEFAULT_WORKSPACE, OTHER_WORKSPACE};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::path::PathBuf;

const WS: &str = DEFAULT_WORKSPACE;
const OTHER: &str = OTHER_WORKSPACE;
const TODAY: &str = "2026-11-17";

type Row = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Vec<String>,
);

/// Everything a restore must reproduce, in saved order.
async fn state(pool: &SqlitePool, workspace: &str) -> Vec<Row> {
    let mut rows = Vec::new();
    for habit in list(pool, workspace).await.unwrap() {
        let days = history(pool, workspace, &habit.id).await.unwrap();
        rows.push((
            habit.name,
            habit.start_date,
            habit.archived_on,
            habit.source_id,
            habit.source,
            days,
        ));
    }
    rows
}

/// Active, archived (with history), empty, and Ember-sourced habits.
async fn fill(pool: &SqlitePool, workspace: &str) {
    let walk = create(pool, workspace, "Walk", Some("2026-11-01"), TODAY)
        .await
        .unwrap();
    let read = create(pool, workspace, "Read", Some("2026-11-01"), TODAY)
        .await
        .unwrap();
    create(pool, workspace, "Empty", Some("2026-11-10"), TODAY)
        .await
        .unwrap();
    let ember = create(pool, workspace, "From Ember", Some("2026-10-01"), TODAY)
        .await
        .unwrap();
    for (id, date) in [
        (&walk.id, "2026-11-02"),
        (&walk.id, "2026-11-16"),
        (&read.id, "2026-11-03"),
        (&ember.id, "2026-10-05"),
    ] {
        set_completion(pool, workspace, id, date, true, TODAY)
            .await
            .unwrap();
    }
    archive(pool, workspace, &read.id, "2026-11-12")
        .await
        .unwrap();
    sqlx::query("UPDATE habits SET source = 'ember', source_id = 'e-1' WHERE id = ?")
        .bind(&ember.id)
        .execute(pool)
        .await
        .unwrap();
}

struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("habit-copies-{}", uuid::Uuid::new_v4())))
    }
    fn files(&self) -> Vec<String> {
        std::fs::read_dir(&self.0)
            .map(|dir| {
                dir.map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn restored(
    pool: &SqlitePool,
    workspace: &str,
    content: &str,
    folder: &Folder,
) -> RestoreReport {
    let seen = restore(pool, workspace, content, None, &folder.0)
        .await
        .unwrap();
    assert_eq!(seen.fatal, None);
    assert!(!seen.applied);
    restore(pool, workspace, content, Some(&seen.token), &folder.0)
        .await
        .unwrap()
}

#[test]
fn a_backup_restores_exact_history_and_order_in_another_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER, "Disposable").await;
        fill(&pool, WS).await;
        let before = state(&pool, WS).await;
        let (content, habits, completions) = backup_json(&pool, WS).await.unwrap();
        assert_eq!((habits, completions), (4, 4));
        create(&pool, OTHER, "Old other", Some("2026-11-01"), TODAY)
            .await
            .unwrap();

        let folder = Folder::new();
        let preview = restore(&pool, OTHER, &content, None, &folder.0)
            .await
            .unwrap();
        assert_eq!(
            (
                preview.habits,
                preview.archived,
                preview.completions,
                preview.current_habits
            ),
            (4, 1, 4, 1)
        );
        // A preview writes neither habits nor a copy.
        assert_eq!(state(&pool, OTHER).await.len(), 1);
        assert!(folder.files().is_empty());

        let done = restored(&pool, OTHER, &content, &folder).await;
        assert!(done.applied);
        assert_eq!(state(&pool, OTHER).await, before);
        // The first workspace is untouched, and the habits have their own IDs.
        assert_eq!(state(&pool, WS).await, before);
        let ids = |rows: Vec<super::Habit>| rows.into_iter().map(|h| h.id).collect::<Vec<_>>();
        let (a, b) = (
            ids(list(&pool, WS).await.unwrap()),
            ids(list(&pool, OTHER).await.unwrap()),
        );
        assert!(a.iter().all(|id| !b.contains(id)));
        // The replaced habit is in the private copy.
        let name = done.recovery.unwrap();
        let copy = std::fs::read_to_string(folder.0.join(name)).unwrap();
        assert!(copy.contains("Old other"));
    });
}

#[test]
fn a_copy_is_written_before_replacing_and_undo_restores_it() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        fill(&pool, WS).await;
        let (backup, ..) = backup_json(&pool, WS).await.unwrap();
        let saved = state(&pool, WS).await;
        // Later edits: a new habit and another completed day.
        let newer = create(&pool, WS, "Newer", Some("2026-11-05"), TODAY)
            .await
            .unwrap();
        set_completion(&pool, WS, &newer.id, "2026-11-06", true, TODAY)
            .await
            .unwrap();
        let latest = state(&pool, WS).await;
        assert_ne!(latest, saved);

        let folder = Folder::new();
        let done = restored(&pool, WS, &backup, &folder).await;
        assert_eq!(state(&pool, WS).await, saved);
        let name = done.recovery.clone().unwrap();
        assert_eq!(folder.files(), [name.clone()]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &std::path::Path| {
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777
            };
            assert_eq!(mode(&folder.0), 0o700);
            assert_eq!(mode(&folder.0.join(&name)), 0o600);
        }

        // Undo brings back what the restore replaced, and can be undone itself.
        let undone = undo(&pool, WS, &name, &folder.0).await.unwrap();
        assert!(undone.applied);
        assert_eq!(state(&pool, WS).await, latest);
        assert_eq!(folder.files().len(), 2);
        undo(&pool, WS, &undone.recovery.unwrap(), &folder.0)
            .await
            .unwrap();
        assert_eq!(state(&pool, WS).await, saved);
    });
}

#[test]
fn nothing_is_replaced_when_the_copy_cannot_be_written() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        fill(&pool, WS).await;
        let (backup, ..) = backup_json(&pool, WS).await.unwrap();
        create(&pool, WS, "Newer", Some("2026-11-05"), TODAY)
            .await
            .unwrap();
        let before = state(&pool, WS).await;
        let seen = restore(&pool, WS, &backup, None, &Folder::new().0)
            .await
            .unwrap();

        // A file where the folder should be makes the copy impossible.
        let blocker = std::env::temp_dir().join(format!("blocker-{}", uuid::Uuid::new_v4()));
        std::fs::write(&blocker, "x").unwrap();
        let result = restore(&pool, WS, &backup, Some(&seen.token), &blocker).await;
        std::fs::remove_file(&blocker).unwrap();
        assert_eq!(result, Err(HabitError::CopyFailed));
        assert_eq!(state(&pool, WS).await, before);
    });
}

#[test]
fn stale_invalid_and_failed_restores_leave_history_intact() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        fill(&pool, WS).await;
        let (content, ..) = backup_json(&pool, WS).await.unwrap();
        let folder = Folder::new();
        let seen = restore(&pool, WS, &content, None, &folder.0).await.unwrap();

        // A completion lands after the preview.
        let walk = list(&pool, WS).await.unwrap().remove(0);
        set_completion(&pool, WS, &walk.id, "2026-11-10", true, TODAY)
            .await
            .unwrap();
        let before = state(&pool, WS).await;
        let stale = restore(&pool, WS, &content, Some(&seen.token), &folder.0)
            .await
            .unwrap();
        assert!(stale.fatal.unwrap().contains("changed since the preview"));
        assert_eq!(state(&pool, WS).await, before);

        let valid: Value = serde_json::from_str(&content).unwrap();
        let change = |edit: &dyn Fn(&mut Value)| {
            let mut value = valid.clone();
            edit(&mut value);
            value.to_string()
        };
        let cases: Vec<(String, &str)> = vec![
            (change(&|b| b["version"] = json!(2)), "newer version"),
            (change(&|b| b["version"] = json!(0)), "not supported"),
            (
                change(&|b| b["format"] = json!("other")),
                "not a habit backup",
            ),
            (change(&|b| b["extra"] = json!(1)), "not valid"),
            ("nope".into(), "not a JSON file"),
            ("[]".into(), "not a habit backup"),
            (
                change(&|b| b["habits"][0]["startDate"] = json!("2027-02-29")),
                "valid calendar date",
            ),
            (
                change(&|b| b["habits"][1]["archivedOn"] = json!("2026-10-01")),
                "archived before it started",
            ),
            (change(&|b| b["habits"][0]["name"] = json!(" ")), "1 to 60"),
            (
                change(&|b| b["habits"][2]["name"] = json!("walk")),
                "Two active habits",
            ),
            (
                change(&|b| b["habits"][2]["id"] = b["habits"][0]["id"].clone()),
                "repeats a habit",
            ),
            (
                change(&|b| b["habits"][0]["source"] = json!("ember")),
                "invalid source",
            ),
            (
                change(&|b| {
                    b["completions"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(["missing", "2026-11-01"]))
                }),
                "not in the file",
            ),
            (
                change(&|b| {
                    let first = b["completions"][0].clone();
                    b["completions"].as_array_mut().unwrap().push(first)
                }),
                "repeated completion",
            ),
            (
                change(&|b| {
                    let id = b["habits"][1]["id"].clone();
                    b["completions"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!([id, "2026-11-20"]))
                }),
                "outside its active days",
            ),
        ];
        for (content, expected) in &cases {
            let report = restore(&pool, WS, content, None, &folder.0).await.unwrap();
            let message = report
                .fatal
                .unwrap_or_else(|| panic!("accepted: {expected}"));
            assert!(message.contains(expected), "{message} lacks {expected}");
            let forced = restore(&pool, WS, content, Some("token"), &folder.0)
                .await
                .unwrap();
            assert!(forced.fatal.is_some() && !forced.applied);
        }
        assert_eq!(state(&pool, WS).await, before);
        assert!(folder.files().is_empty(), "no copy for a refused restore");

        // A failure after the old habits were deleted rolls everything back.
        let fresh = restore(&pool, WS, &content, None, &folder.0).await.unwrap();
        sqlx::query(
            "CREATE TRIGGER fail_restore BEFORE INSERT ON habit_completions
             BEGIN SELECT RAISE(ABORT, 'test'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        let failed = restore(&pool, WS, &content, Some(&fresh.token), &folder.0).await;
        assert_eq!(failed, Err(HabitError::StorageFailed));
        assert_eq!(state(&pool, WS).await, before);
    });
}

#[test]
fn bounds_are_enforced_before_any_write() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let folder = Folder::new();
        let habits: Vec<Value> = (0..1001)
            .map(|i| {
                json!({ "id": format!("h{i}"), "name": format!("Habit {i}"),
                "startDate": "2026-01-01", "archivedOn": null, "source": null, "sourceId": null })
            })
            .collect();
        let content = json!({ "format": "unhollowed-2/habits", "version": 1,
            "exportedAt": "2026-11-17T00:00:00Z", "habits": habits, "completions": [] })
        .to_string();
        let report = restore(&pool, WS, &content, None, &folder.0).await.unwrap();
        assert!(report.fatal.unwrap().contains("1000"));
        let huge = " ".repeat(super::import::MAX_BYTES + 1);
        let report = restore(&pool, WS, &huge, None, &folder.0).await.unwrap();
        assert!(report.fatal.unwrap().contains("32 MiB"));
        assert!(list(&pool, WS).await.unwrap().is_empty());
    });
}

#[test]
fn undo_only_opens_copies_inside_the_folder() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let folder = Folder::new();
        for name in [
            "../habits-pre-restore-1.json",
            "habits-pre-restore-1.json/../x",
            "habits-pre-restore-.json",
            "habits-pre-restore-1.txt",
            "other.json",
            "",
        ] {
            assert_eq!(
                undo(&pool, WS, name, &folder.0).await,
                Err(HabitError::NotFound),
                "{name}"
            );
        }
        // A well-formed name that does not exist.
        assert_eq!(
            undo(&pool, WS, "habits-pre-restore-1.json", &folder.0).await,
            Err(HabitError::FileFailed)
        );
    });
}

#[test]
fn history_exports_escape_csv_and_neutralize_formulas() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let names = [
            "Say \"hi\"",
            "=1+1",
            "+SUM(A1)",
            "-2",
            "@cmd",
            "Plain, comma",
            "Empty habit",
        ];
        let mut ids = Vec::new();
        for name in names {
            ids.push(
                create(&pool, WS, name, Some("2026-11-01"), TODAY)
                    .await
                    .unwrap()
                    .id,
            );
        }
        // The last habit has no completed days.
        for (index, id) in ids.iter().take(6).enumerate() {
            set_completion(&pool, WS, id, "2026-11-02", true, TODAY)
                .await
                .unwrap();
            let _ = index;
        }
        let (csv, rows) = export_history(&pool, WS, "csv").await.unwrap();
        assert_eq!(rows, 6);
        let lines: Vec<&str> = csv.split("\r\n").collect();
        assert_eq!(lines[0], "date,habit_id,habit_name");
        let cell = |i: usize| lines[i + 1].splitn(3, ',').nth(2).unwrap().to_owned();
        assert_eq!(cell(0), "\"Say \"\"hi\"\"\"");
        assert_eq!(cell(1), "\"'=1+1\"");
        assert_eq!(cell(2), "\"'+SUM(A1)\"");
        assert_eq!(cell(3), "\"'-2\"");
        assert_eq!(cell(4), "\"'@cmd\"");
        assert_eq!(cell(5), "\"Plain, comma\"");
        assert!(!csv.contains("Empty habit"));
        assert!(csv.ends_with("\r\n"));

        let (json_text, rows) = export_history(&pool, WS, "json").await.unwrap();
        let parsed: Value = serde_json::from_str(&json_text).unwrap();
        assert_eq!((rows, parsed.as_array().unwrap().len()), (6, 6));
        assert_eq!(parsed[1]["habitName"], "=1+1");
        assert_eq!(parsed[0]["date"], "2026-11-02");
        assert_eq!(
            export_history(&pool, WS, "xml").await,
            Err(HabitError::InvalidFormat)
        );
    });
}
