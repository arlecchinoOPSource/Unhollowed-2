//! Calendar, habit, mood, and analytics regressions across restarts and an
//! upgrade (U2-P6-11). Real SQLite files; synthetic data.

use crate::analytics::workspace_analytics;
use crate::scheduling::{create_event, list_items, recurrence::RepeatRule, EventInput, ItemRange};
use crate::test_support::{migrator, TempDatabase, DEFAULT_WORKSPACE};
use crate::{checkins, habits};
use sqlx::SqlitePool;

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";

async fn open(database: &TempDatabase) -> SqlitePool {
    let pool = database.open().await;
    migrator(i64::MAX).await.run(&pool).await.unwrap();
    pool
}

async fn starts(pool: &SqlitePool, zone: &str) -> Vec<String> {
    let range = ItemRange {
        from: "2026-10-23".into(),
        to: "2026-10-30".into(),
        time_zone: zone.into(),
    };
    list_items(pool, WS, range)
        .await
        .unwrap()
        .items
        .into_iter()
        .filter(|item| item.title == "Daily review")
        .map(|item| item.start.unwrap())
        .collect()
}

/// A daily 09:00 Paris event across the October 25 clock change keeps its
/// wall-clock time in Paris, shifts by an hour for a viewer in New York (whose
/// own clocks change a week later), and survives a restart unchanged.
#[test]
fn a_recurring_event_keeps_its_local_time_across_daylight_saving_and_a_restart() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("calendar-dst");
        let pool = open(&database).await;
        create_event(
            &pool,
            WS,
            EventInput {
                title: "Daily review".into(),
                time_zone: Some("Europe/Paris".into()),
                start: Some("2026-10-23T09:00".into()),
                end: Some("2026-10-23T09:30".into()),
                repeat: Some(RepeatRule {
                    freq: "daily".into(),
                    interval: 1,
                    count: Some(7),
                    until: None,
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let paris = starts(&pool, "Europe/Paris").await;
        assert_eq!(paris.len(), 7);
        assert!(
            paris.iter().all(|start| start.ends_with("T09:00")),
            "{paris:?}"
        );
        let new_york = starts(&pool, "America/New_York").await;
        assert_eq!(new_york.len(), 7);
        // Before Oct 25 Paris is 6 hours ahead (03:00 in New York); from Oct 25
        // it is 5 hours ahead until New York changes on Nov 1 (04:00).
        assert!(new_york[0].ends_with("T03:00"), "{new_york:?}");
        assert!(new_york[2].ends_with("T04:00"), "{new_york:?}");
        pool.close().await;

        let pool = open(&database).await;
        assert_eq!(starts(&pool, "Europe/Paris").await, paris);
        assert_eq!(starts(&pool, "America/New_York").await, new_york);
    });
}

/// Habit history, archiving, restoring, mood records, and the analytics built
/// from them stay consistent across restarts.
#[test]
fn habit_history_archive_restore_and_mood_stay_consistent_across_restarts() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("habit-mood-restart");
        let pool = open(&database).await;
        let habit = habits::create(&pool, WS, "Read", Some("2026-11-01"), TODAY)
            .await
            .unwrap();
        let days = [
            "2026-11-03",
            "2026-11-04",
            "2026-11-05",
            "2026-11-10",
            "2026-11-17",
        ];
        for day in days {
            habits::set_completion(&pool, WS, &habit.id, day, true, TODAY)
                .await
                .unwrap();
        }
        for (day, mood) in [("2026-11-15", 2), ("2026-11-16", 4), ("2026-11-17", 5)] {
            checkins::save(&pool, WS, day, Some(mood), None, None, None, TODAY)
                .await
                .unwrap();
        }
        let analytics = |pool: SqlitePool| async move {
            let all = workspace_analytics(
                &pool,
                WS,
                "2026-11-01",
                "2026-11-30",
                None,
                "Europe/Paris",
                TODAY,
            )
            .await
            .unwrap();
            serde_json::to_value(&all).unwrap()
        };
        let live = analytics(pool.clone()).await;
        assert_eq!(live["habits"]["data"]["completed"], 5);
        assert_eq!(live["mood"]["data"]["daysRecorded"], 3);

        // Archive keeps every completion, restore brings the habit back, and
        // the history is the same list in the same order each time.
        habits::archive(&pool, WS, &habit.id, TODAY).await.unwrap();
        assert_eq!(habits::history(&pool, WS, &habit.id).await.unwrap(), days);
        habits::restore(&pool, WS, &habit.id).await.unwrap();
        pool.close().await;

        let pool = open(&database).await;
        assert_eq!(habits::history(&pool, WS, &habit.id).await.unwrap(), days);
        assert_eq!(analytics(pool.clone()).await, live);
        let restored = habits::get(&pool, WS, &habit.id).await.unwrap();
        assert!(restored.archived_on.is_none());
    });
}

/// A database from before habits and check-ins existed gains them on upgrade
/// with its issue and deadline unchanged, and the new tables start empty.
#[test]
fn an_upgrade_from_before_habits_keeps_issue_deadlines_and_adds_empty_habit_tables() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("calendar-upgrade");
        let pool = database.open().await;
        migrator(25).await.run(&pool).await.unwrap();
        let issue = crate::test_support::add_issue_before_upgrade(&pool, WS, None).await;
        sqlx::query("UPDATE issues SET due_date = '2026-11-20' WHERE id = ?")
            .bind(&issue)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let pool = open(&database).await;
        for table in [
            "habits",
            "habit_completions",
            "daily_checkins",
            "dashboards",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count, 0, "{table}");
        }
        let range = ItemRange {
            from: "2026-11-16".into(),
            to: "2026-11-23".into(),
            time_zone: "Europe/Paris".into(),
        };
        let items = list_items(&pool, WS, range).await.unwrap().items;
        let deadline = items
            .iter()
            .find(|item| item.issue_id.as_deref() == Some(issue.as_str()))
            .expect("the deadline is still on the calendar");
        assert_eq!(deadline.start_date.as_deref(), Some("2026-11-20"));
    });
}
