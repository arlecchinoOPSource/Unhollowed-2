//! Habit commands: lifecycle, eligibility, reviewed deletion, workspace
//! scope, rollback, and concurrent writes. Fixtures follow docs/HABITS.md.

use super::*;
use crate::test_support::{
    add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";

async fn habit(pool: &SqlitePool, name: &str, start: &str) -> Habit {
    create(pool, WS, name, Some(start), TODAY).await.unwrap()
}

async fn set(pool: &SqlitePool, id: &str, date: &str, done: bool) -> Result<bool, HabitError> {
    set_completion(pool, WS, id, date, done, TODAY).await
}

fn names(habits: &[Habit]) -> Vec<&str> {
    habits.iter().map(|habit| habit.name.as_str()).collect()
}

#[test]
fn create_rename_and_reorder_keep_identity_and_completions() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let walk = habit(&pool, "Walk", "2026-11-01").await;
        let read = habit(&pool, "Read", "2026-11-01").await;
        // Without a start date a habit starts today.
        let sleep = create(&pool, WS, "  Sleep  ", None, TODAY).await.unwrap();
        assert_eq!(
            (sleep.name.as_str(), sleep.start_date.as_str()),
            ("Sleep", TODAY)
        );
        assert_eq!([walk.position, read.position, sleep.position], [0, 1, 2]);
        set(&pool, &walk.id, "2026-11-02", true).await.unwrap();

        let renamed = rename(&pool, WS, &walk.id, "Long walk").await.unwrap();
        assert_eq!(renamed.id, walk.id);
        let order = vec![sleep.id.clone(), walk.id.clone(), read.id.clone()];
        let saved = reorder(&pool, WS, &order).await.unwrap();
        assert_eq!(names(&saved), ["Sleep", "Long walk", "Read"]);
        let saved_ids: Vec<String> = saved.iter().map(|h| h.id.clone()).collect();
        assert_eq!(saved_ids, order);
        assert_eq!(history(&pool, WS, &walk.id).await.unwrap(), ["2026-11-02"]);
        // A habit created after a reorder still goes last.
        assert_eq!(habit(&pool, "Journal", "2026-11-01").await.position, 3);

        // An order must name every habit once, archived ones included.
        let all = list(&pool, WS).await.unwrap();
        let ids: Vec<String> = all.iter().map(|h| h.id.clone()).collect();
        for bad in [
            ids[..3].to_vec(),
            [&ids[..3], &ids[..1]].concat(),
            [&ids[..3], &[Uuid::new_v4().to_string()]].concat(),
        ] {
            assert_eq!(
                reorder(&pool, WS, &bad).await,
                Err(HabitError::InvalidOrder)
            );
        }
        assert_eq!(list(&pool, WS).await.unwrap(), all);
    });
}

#[test]
fn names_and_dates_are_validated() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for bad in ["", "   ", &"x".repeat(61), "Tab\there"] {
            assert_eq!(
                create(&pool, WS, bad, None, TODAY).await,
                Err(HabitError::InvalidName)
            );
        }
        create(&pool, WS, &"é".repeat(60), None, TODAY)
            .await
            .unwrap();
        for bad in [
            "2027-02-29",
            "2026-1-01",
            "2026-11-01T00:00",
            "+02026-11-01",
            "soon",
        ] {
            assert_eq!(
                create(&pool, WS, "Dated", Some(bad), TODAY).await,
                Err(HabitError::InvalidDate)
            );
        }
        let walk = habit(&pool, "Walk", "2026-11-01").await;
        assert_eq!(
            create(&pool, WS, "WALK", None, TODAY).await,
            Err(HabitError::DuplicateName)
        );
        assert_eq!(
            rename(&pool, WS, &walk.id, "").await,
            Err(HabitError::InvalidName)
        );
        assert_eq!(
            set(&pool, &walk.id, "2026-02-30", true).await,
            Err(HabitError::InvalidDate)
        );
        assert_eq!(
            month(&pool, WS, 2026, 13, TODAY).await.map(|_| ()),
            Err(HabitError::InvalidMonth)
        );
    });
}

#[test]
fn future_pre_start_and_inactive_days_are_rejected() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        // Docs fixture F3: today 2026-11-17, started 2026-11-05.
        let active = habit(&pool, "Active", "2026-11-05").await;
        let retired = habit(&pool, "Retired", "2026-11-05").await;
        let archived = archive(&pool, WS, &retired.id, "2026-11-12").await.unwrap();
        assert_eq!(archived.archived_on.as_deref(), Some("2026-11-12"));

        let cases = [
            (
                "2026-11-04",
                Err(HabitError::BeforeStart),
                Err(HabitError::BeforeStart),
            ),
            ("2026-11-05", Ok(true), Ok(true)),
            ("2026-11-12", Ok(true), Ok(true)),
            ("2026-11-13", Ok(true), Err(HabitError::Inactive)),
            ("2026-11-17", Ok(true), Err(HabitError::Inactive)),
            (
                "2026-11-18",
                Err(HabitError::FutureDate),
                Err(HabitError::FutureDate),
            ),
        ];
        for (date, for_active, for_retired) in cases {
            assert_eq!(
                set(&pool, &active.id, date, true).await,
                for_active,
                "{date}"
            );
            assert_eq!(
                set(&pool, &retired.id, date, true).await,
                for_retired,
                "{date}"
            );
        }
        assert_eq!(
            history(&pool, WS, &retired.id).await.unwrap(),
            ["2026-11-05", "2026-11-12"]
        );
        // Clearing an ineligible day is refused too, not silently accepted.
        assert_eq!(
            set(&pool, &retired.id, "2026-11-13", false).await,
            Err(HabitError::Inactive)
        );

        // A habit that starts after today is archived on its start day.
        let later = habit(&pool, "Later", "2026-11-20").await;
        let later = archive(&pool, WS, &later.id, TODAY).await.unwrap();
        assert_eq!(later.archived_on.as_deref(), Some("2026-11-20"));
    });
}

#[test]
fn saving_a_state_twice_changes_nothing() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let walk = habit(&pool, "Walk", "2026-11-01").await;
        assert_eq!(set(&pool, &walk.id, "2026-11-03", true).await, Ok(true));
        assert_eq!(set(&pool, &walk.id, "2026-11-03", true).await, Ok(true));
        assert_eq!(get(&pool, WS, &walk.id).await.unwrap().revision, 1);
        assert_eq!(history(&pool, WS, &walk.id).await.unwrap(), ["2026-11-03"]);
        assert_eq!(set(&pool, &walk.id, "2026-11-03", false).await, Ok(false));
        assert_eq!(set(&pool, &walk.id, "2026-11-03", false).await, Ok(false));
        assert_eq!(get(&pool, WS, &walk.id).await.unwrap().revision, 2);
        assert!(history(&pool, WS, &walk.id).await.unwrap().is_empty());
    });
}

#[test]
fn archive_and_restore_keep_history() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let walk = habit(&pool, "Walk", "2026-11-01").await;
        set(&pool, &walk.id, "2026-11-10", true).await.unwrap();
        let archived = archive(&pool, WS, &walk.id, "2026-11-10").await.unwrap();
        // Archiving again is a no-op: the archive day does not move.
        assert_eq!(archive(&pool, WS, &walk.id, TODAY).await.unwrap(), archived);
        assert_eq!(history(&pool, WS, &walk.id).await.unwrap(), ["2026-11-10"]);
        assert_eq!(list(&pool, WS).await.unwrap().len(), 1);

        // The name is free while archived, so restoring the old habit is refused.
        let other = habit(&pool, "walk", "2026-11-11").await;
        assert_eq!(
            restore(&pool, WS, &walk.id).await,
            Err(HabitError::DuplicateName)
        );
        rename(&pool, WS, &other.id, "Run").await.unwrap();

        let restored = restore(&pool, WS, &walk.id).await.unwrap();
        assert_eq!(restored.id, walk.id);
        assert_eq!(restored.archived_on, None);
        assert_eq!(restored.position, walk.position);
        assert_eq!(history(&pool, WS, &walk.id).await.unwrap(), ["2026-11-10"]);
        // The days it spent archived are eligible again.
        assert_eq!(set(&pool, &walk.id, "2026-11-14", true).await, Ok(true));
        assert_eq!(
            restore(&pool, WS, &walk.id).await.unwrap().archived_on,
            None
        );
    });
}

#[test]
fn deletion_needs_an_archived_habit_and_a_current_review() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let walk = habit(&pool, "Walk", "2026-11-01").await;
        let keep = habit(&pool, "Read", "2026-11-01").await;
        for date in ["2026-11-02", "2026-11-09"] {
            set(&pool, &walk.id, date, true).await.unwrap();
        }
        set(&pool, &keep.id, "2026-11-02", true).await.unwrap();
        let impact = deletion_impact(&pool, WS, &walk.id).await.unwrap();
        assert_eq!(
            delete(&pool, WS, &walk.id, impact.revision).await,
            Err(HabitError::NotArchived)
        );

        archive(&pool, WS, &walk.id, TODAY).await.unwrap();
        let reviewed = deletion_impact(&pool, WS, &walk.id).await.unwrap();
        assert_eq!(reviewed.completions, 2);
        assert_eq!(reviewed.first_date.as_deref(), Some("2026-11-02"));
        assert_eq!(reviewed.last_date.as_deref(), Some("2026-11-09"));
        // History that changes after the review must be reviewed again.
        set(&pool, &walk.id, "2026-11-03", true).await.unwrap();
        assert_eq!(
            delete(&pool, WS, &walk.id, reviewed.revision).await,
            Err(HabitError::Changed)
        );
        let again = deletion_impact(&pool, WS, &walk.id).await.unwrap();
        rename(&pool, WS, &walk.id, "Old walk").await.unwrap();
        assert_eq!(
            delete(&pool, WS, &walk.id, again.revision).await,
            Err(HabitError::Changed)
        );
        let current = deletion_impact(&pool, WS, &walk.id).await.unwrap();
        assert_eq!(current.completions, 3);
        delete(&pool, WS, &walk.id, current.revision).await.unwrap();

        assert_eq!(get(&pool, WS, &walk.id).await, Err(HabitError::NotFound));
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM habit_completions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 1);
        assert_eq!(names(&list(&pool, WS).await.unwrap()), ["Read"]);
    });
}

#[test]
fn another_workspace_is_invisible_and_untouchable() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let theirs = create(&pool, OTHER_WORKSPACE, "Walk", Some("2026-11-01"), TODAY)
            .await
            .unwrap();
        set_completion(
            &pool,
            OTHER_WORKSPACE,
            &theirs.id,
            "2026-11-02",
            true,
            TODAY,
        )
        .await
        .unwrap();
        archive(&pool, OTHER_WORKSPACE, &theirs.id, TODAY)
            .await
            .unwrap();
        let id = theirs.id.as_str();

        assert!(list(&pool, WS).await.unwrap().is_empty());
        assert_eq!(get(&pool, WS, id).await, Err(HabitError::NotFound));
        assert_eq!(
            rename(&pool, WS, id, "Mine").await,
            Err(HabitError::NotFound)
        );
        assert_eq!(
            archive(&pool, WS, id, TODAY).await,
            Err(HabitError::NotFound)
        );
        assert_eq!(restore(&pool, WS, id).await, Err(HabitError::NotFound));
        assert_eq!(history(&pool, WS, id).await, Err(HabitError::NotFound));
        assert_eq!(
            set(&pool, id, "2026-11-03", true).await,
            Err(HabitError::NotFound)
        );
        assert_eq!(
            deletion_impact(&pool, WS, id).await.map(|_| ()),
            Err(HabitError::NotFound)
        );
        assert_eq!(delete(&pool, WS, id, 2).await, Err(HabitError::NotFound));
        assert_eq!(
            reorder(&pool, WS, &[theirs.id.clone()]).await,
            Err(HabitError::InvalidOrder)
        );
        let november = month(&pool, WS, 2026, 11, TODAY).await.unwrap();
        assert!(november.habits.is_empty() && november.completions.is_empty());
        // Their habit is untouched, and the same name is free here.
        let after = get(&pool, OTHER_WORKSPACE, id).await.unwrap();
        assert_eq!((after.name.as_str(), after.revision), ("Walk", 2));
        habit(&pool, "Walk", "2026-11-01").await;
    });
}

#[test]
fn month_shows_eligible_habits_in_order_with_their_completions() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        // Docs fixture F1, with today 2028-03-01.
        let today = "2028-03-01";
        let walk = create(&pool, WS, "Synthetic walk", Some("2028-01-01"), today)
            .await
            .unwrap();
        let retired = create(&pool, WS, "Synthetic retired", Some("2027-12-01"), today)
            .await
            .unwrap();
        let read = create(&pool, WS, "Synthetic read", Some("2028-02-01"), today)
            .await
            .unwrap();
        set_completion(&pool, WS, &retired.id, "2028-01-10", true, today)
            .await
            .unwrap();
        archive(&pool, WS, &retired.id, "2028-01-15").await.unwrap();
        for date in ["2028-02-28", "2028-02-29"] {
            set_completion(&pool, WS, &read.id, date, true, today)
                .await
                .unwrap();
        }
        assert_eq!(
            set_completion(&pool, WS, &retired.id, "2028-01-16", true, today).await,
            Err(HabitError::Inactive)
        );

        let december = month(&pool, WS, 2027, 12, today).await.unwrap();
        assert_eq!(names(&december.habits), ["Synthetic retired"]);
        let january = month(&pool, WS, 2028, 1, today).await.unwrap();
        assert_eq!(
            names(&january.habits),
            ["Synthetic walk", "Synthetic retired"]
        );
        assert_eq!(
            january.completions,
            [Completion {
                habit_id: retired.id.clone(),
                date: "2028-01-10".into()
            }]
        );
        let february = month(&pool, WS, 2028, 2, today).await.unwrap();
        assert_eq!(february.today, today);
        assert_eq!(
            names(&february.habits),
            ["Synthetic walk", "Synthetic read"]
        );
        let dates: Vec<&str> = february
            .completions
            .iter()
            .map(|c| c.date.as_str())
            .collect();
        assert_eq!(dates, ["2028-02-28", "2028-02-29"]);
        assert!(february.completions.iter().all(|c| c.habit_id == read.id));
        // Columns follow the saved order, not creation.
        reorder(
            &pool,
            WS,
            &[read.id.clone(), retired.id.clone(), walk.id.clone()],
        )
        .await
        .unwrap();
        let february = month(&pool, WS, 2028, 2, today).await.unwrap();
        assert_eq!(
            names(&february.habits),
            ["Synthetic read", "Synthetic walk"]
        );
    });
}

#[test]
fn a_failed_write_rolls_back_completely() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let walk = habit(&pool, "Walk", "2026-11-01").await;
        let read = habit(&pool, "Read", "2026-11-01").await;
        let before = list(&pool, WS).await.unwrap();
        // Fail the last step of each write: the final position of a reorder,
        // and the revision bump after a completion is inserted.
        sqlx::query(
            "CREATE TRIGGER fail_writes BEFORE UPDATE ON habits
             WHEN NEW.position = 1 OR NEW.revision > OLD.revision AND NEW.position = OLD.position
             BEGIN SELECT RAISE(ABORT, 'test failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            reorder(&pool, WS, &[read.id.clone(), walk.id.clone()]).await,
            Err(HabitError::StorageFailed)
        );
        assert_eq!(
            set(&pool, &walk.id, "2026-11-02", true).await,
            Err(HabitError::StorageFailed)
        );
        sqlx::query("DROP TRIGGER fail_writes")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(list(&pool, WS).await.unwrap(), before);
        assert!(history(&pool, WS, &walk.id).await.unwrap().is_empty());
    });
}

#[test]
fn concurrent_writes_are_all_saved_and_survive_reopen() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("habits-concurrent");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let walk = habit(&pool, "Walk", "2026-11-01").await;
        let read = habit(&pool, "Read", "2026-11-01").await;

        let mut tasks = Vec::new();
        for day in 1..=17 {
            let date = format!("2026-11-{day:02}");
            // Walk is checked twice at once on every day; Read on even days.
            for (id, done) in [
                (walk.id.clone(), true),
                (walk.id.clone(), true),
                (read.id.clone(), day % 2 == 0),
            ] {
                let (pool, date) = (pool.clone(), date.clone());
                tasks.push(tauri::async_runtime::spawn(async move {
                    set_completion(&pool, WS, &id, &date, done, TODAY).await
                }));
            }
        }
        for task in tasks {
            assert!(task.await.unwrap().is_ok());
        }
        pool.close().await;

        let pool = database.open().await;
        assert_eq!(history(&pool, WS, &walk.id).await.unwrap().len(), 17);
        assert_eq!(history(&pool, WS, &read.id).await.unwrap().len(), 8);
        // One revision per change: a duplicate of a saved state adds none.
        assert_eq!(get(&pool, WS, &walk.id).await.unwrap().revision, 17);
        assert_eq!(get(&pool, WS, &read.id).await.unwrap().revision, 8);
        pool.close().await;
    });
}
