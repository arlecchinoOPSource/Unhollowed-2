//! The Phase 4 workflow end to end on disposable file databases: upgrade a
//! database from before habits, manage and check habits, import a synthetic
//! Ember backup, record mood, complete an issue, change the calendar, back up
//! and restore into a second database, and restart both. Every total is
//! asserted against the value worked out by hand. docs/PHASE_4.md records
//! the results.

use crate::analytics::{workspace_analytics, WorkspaceAnalytics};
use crate::checkins::{self, analytics::analytics as mood_analytics};
use crate::habits::{
    self, backup, import, routines, stats::statistics, stats::HabitStatistics, HabitError,
};
use crate::issues;
use crate::scheduling::recurrence::RepeatRule;
use crate::scheduling::{create_event, events, EventInput};
use crate::test_support::{add_issue_before_upgrade, migrator, TempDatabase, DEFAULT_WORKSPACE};
use sqlx::SqlitePool;
use std::path::PathBuf;

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";
const ZONE: &str = "Europe/Paris";

/// A synthetic Ember backup: one active habit with two completed days.
const EMBER: &str = r#"{
  "format": "ember-backup",
  "version": 1,
  "habits": [
    { "id": "abcdefabcdefabcdefabcdefabcdefab", "name": "Synthetic journal",
      "sortOrder": 0, "startDate": "2026-11-01", "archivedAt": null }
  ],
  "completions": [
    ["abcdefabcdefabcdefabcdefabcdefab", "2026-11-03"],
    ["abcdefabcdefabcdefabcdefabcdefab", "2026-11-04"]
  ]
}"#;

/// A folder for restore copies that is removed when the test ends.
struct Folder(PathBuf);

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn open(database: &TempDatabase) -> SqlitePool {
    let pool = database.open().await;
    migrator(i64::MAX).await.run(&pool).await.unwrap();
    pool
}

async fn habit_stats(pool: &SqlitePool) -> HabitStatistics {
    statistics(pool, WS, "2026-11-01", "2026-11-30", None, TODAY)
        .await
        .unwrap()
}

async fn dashboard(pool: &SqlitePool) -> WorkspaceAnalytics {
    workspace_analytics(pool, WS, "2026-11-01", "2026-11-30", None, ZONE, TODAY)
        .await
        .unwrap()
}

fn names(habits: &[habits::Habit]) -> Vec<(&str, Option<&str>)> {
    habits
        .iter()
        .map(|habit| (habit.name.as_str(), habit.archived_on.as_deref()))
        .collect()
}

#[test]
fn habits_mood_issues_calendar_backup_and_restart_keep_history_and_totals() {
    tauri::async_runtime::block_on(async {
        let source = TempDatabase::new("phase4-source");
        let target = TempDatabase::new("phase4-target");
        let folder = Folder(
            std::env::temp_dir().join(format!("unhollowed-2-phase4-copies-{}", std::process::id())),
        );

        // A database from before habits (version 25) with an issue due on the 20th.
        let pool = source.open().await;
        migrator(25).await.run(&pool).await.unwrap();
        let issue = add_issue_before_upgrade(&pool, WS, None).await;
        sqlx::query("UPDATE issues SET due_date = '2026-11-20' WHERE id = ?")
            .bind(&issue)
            .execute(&pool)
            .await
            .unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();

        // Create, rename, and reorder.
        let walk = habits::create(&pool, WS, "Walk", Some("2026-11-10"), TODAY)
            .await
            .unwrap();
        let read = habits::create(&pool, WS, "Read", Some("2026-11-10"), TODAY)
            .await
            .unwrap();
        let stretch = habits::create(&pool, WS, "Stretch", Some("2026-11-10"), TODAY)
            .await
            .unwrap();
        habits::rename(&pool, WS, &walk.id, "Morning walk")
            .await
            .unwrap();
        habits::reorder(
            &pool,
            WS,
            &[read.id.clone(), walk.id.clone(), stretch.id.clone()],
        )
        .await
        .unwrap();

        // Check days, including a repeated check and refused dates.
        for day in ["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-17"] {
            assert!(
                habits::set_completion(&pool, WS, &walk.id, day, true, TODAY)
                    .await
                    .unwrap()
            );
        }
        for day in ["2026-11-10", "2026-11-12"] {
            habits::set_completion(&pool, WS, &read.id, day, true, TODAY)
                .await
                .unwrap();
        }
        habits::set_completion(&pool, WS, &stretch.id, "2026-11-11", true, TODAY)
            .await
            .unwrap();
        assert!(matches!(
            habits::set_completion(&pool, WS, &walk.id, "2026-11-18", true, TODAY).await,
            Err(HabitError::FutureDate)
        ));
        assert!(matches!(
            habits::set_completion(&pool, WS, &walk.id, "2026-11-09", true, TODAY).await,
            Err(HabitError::BeforeStart)
        ));
        // Historical navigation: checking and unchecking a past day.
        habits::set_completion(&pool, WS, &read.id, "2026-11-11", true, TODAY)
            .await
            .unwrap();
        habits::set_completion(&pool, WS, &read.id, "2026-11-11", false, TODAY)
            .await
            .unwrap();
        assert_eq!(
            habits::history(&pool, WS, &read.id).await.unwrap(),
            ["2026-11-10", "2026-11-12"]
        );

        // Archive, restore, and delete only after confirming the reviewed impact.
        let archived = habits::archive(&pool, WS, &stretch.id, TODAY)
            .await
            .unwrap();
        assert_eq!(archived.archived_on.as_deref(), Some(TODAY));
        let restored = habits::restore(&pool, WS, &stretch.id).await.unwrap();
        assert_eq!(restored.archived_on, None);
        assert!(matches!(
            habits::delete(&pool, WS, &stretch.id, restored.revision).await,
            Err(HabitError::NotArchived)
        ));
        habits::archive(&pool, WS, &stretch.id, TODAY)
            .await
            .unwrap();
        let impact = habits::deletion_impact(&pool, WS, &stretch.id)
            .await
            .unwrap();
        assert_eq!(
            (impact.completions, impact.first_date.as_deref()),
            (1, Some("2026-11-11"))
        );
        assert!(matches!(
            habits::delete(&pool, WS, &stretch.id, impact.revision - 1).await,
            Err(HabitError::Changed)
        ));
        habits::delete(&pool, WS, &stretch.id, impact.revision)
            .await
            .unwrap();

        // Import the synthetic Ember backup after a matching preview.
        let preview = import::run(&pool, WS, EMBER, None).await.unwrap();
        assert_eq!(preview.fatal, None);
        assert_eq!((preview.habits.len(), preview.completions), (1, 2));
        let imported = import::run(&pool, WS, EMBER, Some(&preview.token))
            .await
            .unwrap();
        assert!(imported.applied);
        let list = habits::list(&pool, WS).await.unwrap();
        assert_eq!(
            names(&list),
            [
                ("Read", None),
                ("Morning walk", None),
                ("Synthetic journal", None)
            ]
        );

        // Streaks and totals. Read and Morning walk are eligible Nov 10–17
        // (8 days each) and Synthetic journal Nov 1–17 (17 days): 33 days, 7 done.
        let stats = habit_stats(&pool).await;
        assert_eq!((stats.summary.eligible, stats.summary.completed), (33, 7));
        let walk_summary = stats
            .habits
            .iter()
            .find(|habit| habit.habit_id == walk.id)
            .unwrap();
        assert_eq!(
            (walk_summary.streaks.current, walk_summary.streaks.longest),
            (3, 3)
        );
        assert_eq!(walk_summary.counts.completed, 3);

        // Partial check-in today and a full historical one; the future is refused.
        checkins::save(&pool, WS, TODAY, Some(4), None, None, None, TODAY)
            .await
            .unwrap();
        checkins::save(
            &pool,
            WS,
            "2026-11-10",
            Some(2),
            Some(3),
            Some(5),
            Some("Synthetic note"),
            TODAY,
        )
        .await
        .unwrap();
        assert!(
            checkins::save(&pool, WS, "2026-11-18", Some(3), None, None, None, TODAY)
                .await
                .is_err()
        );
        let mood = mood_analytics(&pool, WS, "2026-11-01", "2026-11-30", true, TODAY)
            .await
            .unwrap();
        assert_eq!((mood.mood.samples, mood.mood.average), (2, Some(3.0)));
        assert_eq!((mood.energy.samples, mood.energy.average), (1, Some(3.0)));
        assert_eq!((mood.focus.samples, mood.focus.average), (1, Some(5.0)));

        // Calendar: a daily routine linked to the walk, and a meeting that grows.
        let routine = create_event(
            &pool,
            WS,
            EventInput {
                title: "Walk routine".into(),
                time_zone: Some(ZONE.into()),
                start: Some("2026-11-16T07:00".into()),
                end: Some("2026-11-16T07:30".into()),
                repeat: Some(RepeatRule {
                    freq: "daily".into(),
                    interval: 1,
                    count: Some(3),
                    until: None,
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        routines::link(&pool, WS, &walk.id, &routine.id)
            .await
            .unwrap();
        let meeting_input = |start: &str, end: &str| EventInput {
            title: "Planning".into(),
            time_zone: Some(ZONE.into()),
            start: Some(start.into()),
            end: Some(end.into()),
            ..Default::default()
        };
        let meeting = create_event(
            &pool,
            WS,
            meeting_input("2026-11-19T10:00", "2026-11-19T11:00"),
        )
        .await
        .unwrap();
        events::update(
            &pool,
            WS,
            &meeting.id,
            meeting_input("2026-11-19T10:00", "2026-11-19T12:00"),
        )
        .await
        .unwrap();

        // Dashboard before and after completing the issue.
        let before = dashboard(&pool).await;
        let issues_before = before.issues.data.unwrap();
        assert_eq!(
            (issues_before.open, issues_before.overdue, issues_before.due),
            (1, 0, 1)
        );
        assert_eq!(issues_before.due_completed, 0);
        issues::set_status_on(&pool, WS, &issue, "done", Some(TODAY))
            .await
            .unwrap();
        let totals = dashboard(&pool).await;
        let done = totals.issues.data.as_ref().unwrap();
        assert_eq!((done.open, done.due, done.due_completed), (0, 1, 1));
        // Three 30-minute routine occurrences and one two-hour meeting.
        let calendar = totals.calendar.data.as_ref().unwrap();
        assert_eq!(
            (
                calendar.events,
                calendar.timed_events,
                calendar.scheduled_minutes
            ),
            (4, 4, 210)
        );
        let habit_totals = totals.habits.data.as_ref().unwrap();
        assert_eq!((habit_totals.eligible, habit_totals.completed), (33, 7));
        let mood_totals = totals.mood.data.as_ref().unwrap();
        assert_eq!(
            (mood_totals.days_recorded, mood_totals.mood.samples),
            (2, 2)
        );

        // Back up and export, then restore into an empty second database.
        let (content, habit_count, completion_count) =
            backup::backup_json(&pool, WS).await.unwrap();
        assert_eq!((habit_count, completion_count), (3, 7));
        let (csv, rows) = backup::history(&pool, WS, "csv").await.unwrap();
        assert_eq!(rows, 7);
        assert!(csv.starts_with("date,habit_id,habit_name\r\n"));
        let other = open(&target).await;
        let seen = backup::restore(&other, WS, &content, None, &folder.0)
            .await
            .unwrap();
        assert_eq!(seen.fatal, None);
        let applied = backup::restore(&other, WS, &content, Some(&seen.token), &folder.0)
            .await
            .unwrap();
        assert!(applied.applied);
        let restored_stats = habit_stats(&other).await;
        assert_eq!(restored_stats.summary, stats.summary);
        // A restore gives habits new IDs; names, counts, and streaks carry over.
        let without_ids = |s: &HabitStatistics| {
            s.habits
                .iter()
                .map(|h| {
                    (
                        h.name.clone(),
                        h.counts.completed,
                        h.counts.eligible,
                        h.streaks.current,
                        h.streaks.longest,
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(without_ids(&restored_stats), without_ids(&stats));

        let source_stats = habit_stats(&pool).await;
        let source_list = habits::list(&pool, WS).await.unwrap();
        pool.close().await;
        other.close().await;

        // Restart both: history, order, links, mood, and every statistic are
        // recomputed to exactly the same values.
        let pool = open(&source).await;
        assert_eq!(habits::list(&pool, WS).await.unwrap(), source_list);
        assert_eq!(habit_stats(&pool).await, source_stats);
        assert_eq!(dashboard(&pool).await, totals);
        assert_eq!(
            routines::for_habit(&pool, WS, &walk.id)
                .await
                .unwrap()
                .len(),
            1
        );
        let today = checkins::get(&pool, WS, TODAY).await.unwrap().unwrap();
        assert_eq!((today.mood, today.energy), (Some(4), None));
        pool.close().await;

        let other = open(&target).await;
        assert_eq!(
            names(&habits::list(&other, WS).await.unwrap()),
            names(&source_list)
        );
        assert_eq!(habit_stats(&other).await.summary, source_stats.summary);
        other.close().await;
    });
}
