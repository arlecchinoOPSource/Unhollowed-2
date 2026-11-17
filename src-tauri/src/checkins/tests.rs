//! Daily check-ins: nullable ratings, boundaries, the empty save, editing a
//! day, SQLite's own guarantees, workspace scope, and upgrade and restart.

use super::*;
use crate::test_support::{
    add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";

async fn put(
    pool: &SqlitePool,
    date: &str,
    mood: Option<i64>,
    energy: Option<i64>,
    focus: Option<i64>,
    note: Option<&str>,
) -> Result<Option<Checkin>, CheckinError> {
    save(pool, WS, date, mood, energy, focus, note, TODAY).await
}

#[test]
fn partial_check_ins_keep_unset_ratings_unset_and_edits_keep_identity() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let first = put(&pool, "2026-11-10", Some(4), None, None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (first.mood, first.energy, first.focus, first.note.as_deref()),
            (Some(4), None, None, None)
        );
        // Editing the same day replaces the record and keeps who it is.
        let edited = put(
            &pool,
            "2026-11-10",
            None,
            Some(2),
            Some(5),
            Some("  Slept badly \n"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(edited.id, first.id);
        assert_eq!(edited.created_at, first.created_at);
        assert!(edited.updated_at >= first.updated_at);
        // The cleared mood is unset, not kept and not defaulted.
        assert_eq!(
            (
                edited.mood,
                edited.energy,
                edited.focus,
                edited.note.as_deref()
            ),
            (None, Some(2), Some(5), Some("Slept badly"))
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM daily_checkins")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(get(&pool, WS, "2026-11-10").await.unwrap(), Some(edited));
        assert_eq!(get(&pool, WS, "2026-11-11").await.unwrap(), None);
    });
}

#[test]
fn a_save_with_nothing_in_it_removes_the_day() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        put(&pool, "2026-11-10", Some(3), None, None, None)
            .await
            .unwrap();
        // A blank note is nothing.
        assert_eq!(
            put(&pool, "2026-11-10", None, None, None, Some(" \n\t")).await,
            Ok(None)
        );
        assert_eq!(get(&pool, WS, "2026-11-10").await.unwrap(), None);
        // Saving nothing for a day with no record is fine and stores nothing.
        assert_eq!(
            put(&pool, "2026-11-12", None, None, None, None).await,
            Ok(None)
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM daily_checkins")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        // A note alone is a check-in.
        assert!(
            put(&pool, "2026-11-12", None, None, None, Some("Quiet day"))
                .await
                .unwrap()
                .is_some()
        );
        delete(&pool, WS, "2026-11-12").await.unwrap();
        delete(&pool, WS, "2026-11-12").await.unwrap();
        assert_eq!(get(&pool, WS, "2026-11-12").await.unwrap(), None);
    });
}

#[test]
fn ratings_dates_and_notes_are_validated() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for bad in [0, 6, -1, 100, i64::MIN] {
            for slot in 0..3 {
                let mut ratings = [None, None, None];
                ratings[slot] = Some(bad);
                assert_eq!(
                    put(
                        &pool,
                        "2026-11-10",
                        ratings[0],
                        ratings[1],
                        ratings[2],
                        None
                    )
                    .await,
                    Err(CheckinError::InvalidRating),
                    "{bad} in slot {slot}"
                );
            }
        }
        for good in [1, 5] {
            assert!(put(
                &pool,
                "2026-11-10",
                Some(good),
                Some(good),
                Some(good),
                None
            )
            .await
            .is_ok());
        }
        for bad in [
            "2027-02-29",
            "2026-13-01",
            "2026-1-01",
            "2026-11-10 ",
            "",
            "tomorrow",
            "1899-12-31",
        ] {
            assert_eq!(
                put(&pool, bad, Some(3), None, None, None).await,
                Err(CheckinError::InvalidDate),
                "{bad:?}"
            );
            assert_eq!(get(&pool, WS, bad).await, Err(CheckinError::InvalidDate));
        }
        // Today and the past are fine; the future is not.
        assert!(put(&pool, TODAY, Some(3), None, None, None).await.is_ok());
        assert!(put(&pool, "1900-01-01", Some(3), None, None, None)
            .await
            .is_ok());
        assert_eq!(
            put(&pool, "2026-11-18", Some(3), None, None, None).await,
            Err(CheckinError::FutureDate)
        );
        assert!(put(&pool, "2028-02-29", Some(3), None, None, None)
            .await
            .is_err());
        let long = "é".repeat(2000);
        assert!(put(&pool, "2026-11-09", None, None, None, Some(&long))
            .await
            .is_ok());
        assert_eq!(
            put(
                &pool,
                "2026-11-09",
                None,
                None,
                None,
                Some(&"x".repeat(2001))
            )
            .await,
            Err(CheckinError::NoteTooLong)
        );
        // The rejected save changed nothing.
        assert_eq!(
            get(&pool, WS, "2026-11-09")
                .await
                .unwrap()
                .unwrap()
                .note
                .unwrap(),
            long
        );
    });
}

#[test]
fn sqlite_enforces_the_same_rules_on_its_own() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let insert = |workspace: &'static str,
                      date: &'static str,
                      mood: Option<i64>,
                      note: Option<&'static str>| {
            let pool = pool.clone();
            async move {
                sqlx::query(
                    "INSERT INTO daily_checkins (id, workspace_id, date, mood, note)
                     VALUES (?, ?, ?, ?, ?)",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(workspace)
                .bind(date)
                .bind(mood)
                .bind(note)
                .execute(&pool)
                .await
            }
        };
        assert!(insert(WS, "2026-11-10", Some(3), None).await.is_ok());
        assert!(
            insert(WS, "2026-11-10", Some(4), None).await.is_err(),
            "duplicate day"
        );
        assert!(insert(OTHER_WORKSPACE, "2026-11-10", Some(4), None)
            .await
            .is_ok());
        assert!(
            insert(WS, "2026-11-11", Some(6), None).await.is_err(),
            "rating 6"
        );
        assert!(
            insert(WS, "2026-11-11", Some(0), None).await.is_err(),
            "rating 0"
        );
        assert!(
            insert(WS, "2026-11-11", None, None).await.is_err(),
            "empty record"
        );
        assert!(
            insert(WS, "2026-11-11", None, Some("")).await.is_err(),
            "empty note"
        );
        assert!(
            insert(WS, "2026-02-30", Some(3), None).await.is_err(),
            "bad date"
        );
        assert!(
            insert(
                "00000000-0000-4000-8000-0000000000ff",
                "2026-11-11",
                Some(3),
                None
            )
            .await
            .is_err(),
            "unknown workspace"
        );
        // A record cannot be moved to another day or workspace.
        for column in [
            "date = '2026-11-12'",
            "workspace_id = '00000000-0000-4000-8000-000000000002'",
            "id = 'x'",
        ] {
            let result = sqlx::query(&format!(
                "UPDATE daily_checkins SET {column} WHERE workspace_id = ? AND date = '2026-11-10'"
            ))
            .bind(WS)
            .execute(&pool)
            .await;
            assert!(result.is_err(), "{column}");
        }
    });
}

#[test]
fn another_workspace_cannot_see_or_change_a_check_in() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        put(&pool, "2026-11-10", Some(5), Some(5), Some(5), Some("mine"))
            .await
            .unwrap();
        assert_eq!(
            get(&pool, OTHER_WORKSPACE, "2026-11-10").await.unwrap(),
            None
        );
        assert!(list(&pool, OTHER_WORKSPACE, "2026-11-01", "2026-11-30")
            .await
            .unwrap()
            .is_empty());
        // The same day in the other workspace is its own record.
        let theirs = save(
            &pool,
            OTHER_WORKSPACE,
            "2026-11-10",
            Some(1),
            None,
            None,
            None,
            TODAY,
        )
        .await
        .unwrap()
        .unwrap();
        let mine = get(&pool, WS, "2026-11-10").await.unwrap().unwrap();
        assert_ne!(theirs.id, mine.id);
        assert_eq!((mine.mood, mine.note.as_deref()), (Some(5), Some("mine")));
        // Deleting there leaves mine; an empty save there leaves mine.
        delete(&pool, OTHER_WORKSPACE, "2026-11-10").await.unwrap();
        save(
            &pool,
            OTHER_WORKSPACE,
            "2026-11-10",
            None,
            None,
            None,
            None,
            TODAY,
        )
        .await
        .unwrap();
        assert_eq!(get(&pool, WS, "2026-11-10").await.unwrap(), Some(mine));
    });
}

#[test]
fn listing_returns_a_bounded_ordered_range() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for date in ["2026-11-12", "2026-11-03", "2026-12-01"] {
            // 2026-12-01 is after TODAY, so write it with a later today.
            save(&pool, WS, date, Some(3), None, None, None, "2026-12-31")
                .await
                .unwrap();
        }
        let days: Vec<String> = list(&pool, WS, "2026-11-01", "2026-11-30")
            .await
            .unwrap()
            .into_iter()
            .map(|c| c.date)
            .collect();
        assert_eq!(days, ["2026-11-03", "2026-11-12"]);
        // One day is a valid range; its bounds are inclusive.
        assert_eq!(
            list(&pool, WS, "2026-11-03", "2026-11-03")
                .await
                .unwrap()
                .len(),
            1
        );
        for (from, to, error) in [
            ("2026-11-30", "2026-11-01", CheckinError::InvalidRange),
            ("2000-01-01", "2026-11-01", CheckinError::InvalidRange),
            ("2026-02-30", "2026-03-01", CheckinError::InvalidDate),
        ] {
            assert_eq!(list(&pool, WS, from, to).await, Err(error), "{from}..{to}");
        }
    });
}

#[test]
fn check_ins_survive_an_upgrade_and_a_restart() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("checkins-upgrade");
        let pool = database.open().await;
        migrator(26).await.run(&pool).await.unwrap();
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let saved = put(
            &pool,
            "2028-02-29",
            Some(2),
            None,
            Some(4),
            Some("Leap day"),
        )
        .await
        .map(|_| ())
        .err();
        // A leap day after today is refused; an earlier leap day is kept.
        assert_eq!(saved, Some(CheckinError::FutureDate));
        let saved = save(
            &pool,
            WS,
            "2028-02-29",
            Some(2),
            None,
            Some(4),
            Some("Leap day"),
            "2028-03-01",
        )
        .await
        .unwrap()
        .unwrap();
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(get(&pool, WS, "2028-02-29").await.unwrap(), Some(saved));
        pool.close().await;
    });
}
