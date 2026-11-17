//! Habit routines: stable-ID links, renames, archive and delete, workspace
//! isolation, upgrade and restart, and independence from completions.

use super::routines::{choices, for_events, for_habit, link, unlink, Routine};
use super::{archive, create, history, rename, set_completion, HabitError};
use crate::scheduling::recurrence::RepeatRule;
use crate::scheduling::{create_event, events, get_event, EventInput};
use crate::test_support::{
    add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};
use sqlx::SqlitePool;

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";

async fn event(pool: &SqlitePool, workspace: &str, title: &str, repeats: bool) -> String {
    create_event(
        pool,
        workspace,
        EventInput {
            title: title.into(),
            all_day: true,
            start_date: Some("2026-11-02".into()),
            end_date: Some("2026-11-03".into()),
            repeat: repeats.then(|| RepeatRule {
                freq: "daily".into(),
                interval: 1,
                count: None,
                until: None,
            }),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .id
}

async fn habit(pool: &SqlitePool, workspace: &str, name: &str) -> String {
    create(pool, workspace, name, Some("2026-11-01"), TODAY)
        .await
        .unwrap()
        .id
}

async fn links(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM habit_events")
        .fetch_one(pool)
        .await
        .unwrap()
}

fn titles(routines: &[Routine]) -> Vec<&str> {
    routines.iter().map(|r| r.title.as_str()).collect()
}

#[test]
fn a_habit_links_to_recurring_events_by_id_and_unlinks() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let walk = habit(&pool, WS, "Walk").await;
        let morning = event(&pool, WS, "Morning walk", true).await;
        let single = event(&pool, WS, "One-off", false).await;

        let linked = link(&pool, WS, &walk, &morning).await.unwrap();
        assert_eq!(titles(&linked), ["Morning walk"]);
        assert_eq!(
            (
                linked[0].repeat_freq.as_str(),
                linked[0].repeat_interval,
                linked[0].start_date.as_str()
            ),
            ("daily", 1, "2026-11-02")
        );
        // Linking again changes nothing; a one-time event cannot be a routine.
        assert_eq!(link(&pool, WS, &walk, &morning).await.unwrap(), linked);
        assert_eq!(
            link(&pool, WS, &walk, &single).await,
            Err(HabitError::NotRecurring)
        );
        assert_eq!(
            link(&pool, WS, &walk, "missing").await,
            Err(HabitError::NotFound)
        );
        assert_eq!(links(&pool).await, 1);
        // The picker offers recurring events only.
        assert_eq!(titles(&choices(&pool, WS).await.unwrap()), ["Morning walk"]);

        assert!(unlink(&pool, WS, &walk, &morning).await.unwrap().is_empty());
        assert!(unlink(&pool, WS, &walk, &morning).await.unwrap().is_empty());
        // Unlinking left both records.
        assert!(get_event(&pool, WS, &morning).await.is_ok());
        assert_eq!(choices(&pool, WS).await.unwrap().len(), 1);
    });
}

#[test]
fn renames_and_archiving_keep_the_link_and_agenda_shows_active_habits() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let walk = habit(&pool, WS, "Walk").await;
        let read = habit(&pool, WS, "Read").await;
        let routine = event(&pool, WS, "Evening routine", true).await;
        link(&pool, WS, &walk, &routine).await.unwrap();
        link(&pool, WS, &read, &routine).await.unwrap();

        rename(&pool, WS, &walk, "Long walk").await.unwrap();
        let ids = std::slice::from_ref(&routine);
        let shown = for_events(&pool, WS, ids).await.unwrap();
        let names: Vec<_> = shown.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["Long walk", "Read"]);

        // An archived habit keeps its link but leaves the agenda context.
        archive(&pool, WS, &read, TODAY).await.unwrap();
        assert_eq!(for_events(&pool, WS, ids).await.unwrap().len(), 1);
        assert_eq!(links(&pool).await, 2);
        assert_eq!(
            titles(&for_habit(&pool, WS, &read).await.unwrap()),
            ["Evening routine"]
        );
    });
}

#[test]
fn deleting_either_end_removes_only_the_link() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let walk = habit(&pool, WS, "Walk").await;
        let read = habit(&pool, WS, "Read").await;
        let first = event(&pool, WS, "First", true).await;
        let second = event(&pool, WS, "Second", true).await;
        link(&pool, WS, &walk, &first).await.unwrap();
        link(&pool, WS, &read, &second).await.unwrap();
        set_completion(&pool, WS, &walk, "2026-11-10", true, TODAY)
            .await
            .unwrap();

        // Deleting the event removes its link and not the habit or its history.
        events::delete(&pool, WS, &first).await.unwrap();
        assert!(for_habit(&pool, WS, &walk).await.unwrap().is_empty());
        assert_eq!(history(&pool, WS, &walk).await.unwrap(), ["2026-11-10"]);
        // Deleting an archived habit removes its link and not the event.
        archive(&pool, WS, &read, TODAY).await.unwrap();
        let impact = super::deletion_impact(&pool, WS, &read).await.unwrap();
        super::delete(&pool, WS, &read, impact.revision)
            .await
            .unwrap();
        assert_eq!(links(&pool).await, 0);
        assert!(get_event(&pool, WS, &second).await.is_ok());
    });
}

#[test]
fn another_workspace_cannot_be_linked_or_read() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let mine = habit(&pool, WS, "Walk").await;
        let theirs = habit(&pool, OTHER_WORKSPACE, "Their habit").await;
        let my_event = event(&pool, WS, "Mine", true).await;
        let their_event = event(&pool, OTHER_WORKSPACE, "Theirs", true).await;

        // Neither end can come from another workspace.
        assert_eq!(
            link(&pool, WS, &mine, &their_event).await,
            Err(HabitError::NotFound)
        );
        assert_eq!(
            link(&pool, WS, &theirs, &my_event).await,
            Err(HabitError::NotFound)
        );
        assert_eq!(
            link(&pool, OTHER_WORKSPACE, &theirs, &my_event).await,
            Err(HabitError::NotFound)
        );
        assert_eq!(links(&pool).await, 0);
        // SQLite refuses it on its own too.
        let direct = sqlx::query(
            "INSERT INTO habit_events (habit_id, event_id, workspace_id) VALUES (?, ?, ?)",
        )
        .bind(&mine)
        .bind(&their_event)
        .bind(WS)
        .execute(&pool)
        .await;
        assert!(direct.is_err());
        // Reads see only their own workspace.
        link(&pool, OTHER_WORKSPACE, &theirs, &their_event)
            .await
            .unwrap();
        let ids = std::slice::from_ref(&their_event);
        assert!(for_events(&pool, WS, ids).await.unwrap().is_empty());
        assert_eq!(titles(&choices(&pool, WS).await.unwrap()), ["Mine"]);
        assert_eq!(
            for_habit(&pool, WS, &theirs).await,
            Err(HabitError::NotFound)
        );
    });
}

#[test]
fn links_never_create_or_change_completions() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let walk = habit(&pool, WS, "Walk").await;
        let routine = event(&pool, WS, "Daily", true).await;
        set_completion(&pool, WS, &walk, "2026-11-10", true, TODAY)
            .await
            .unwrap();
        let before = super::get(&pool, WS, &walk).await.unwrap();

        // The routine has occurrences on every day since Nov 2, past and today.
        link(&pool, WS, &walk, &routine).await.unwrap();
        let after_link = super::get(&pool, WS, &walk).await.unwrap();
        unlink(&pool, WS, &walk, &routine).await.unwrap();
        link(&pool, WS, &walk, &routine).await.unwrap();

        assert_eq!(history(&pool, WS, &walk).await.unwrap(), ["2026-11-10"]);
        assert_eq!(after_link.revision, before.revision);
        let completions: i64 = sqlx::query_scalar("SELECT count(*) FROM habit_completions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(completions, 1);
    });
}

#[test]
fn links_survive_an_upgrade_and_a_restart() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("routines-upgrade");
        let pool = database.open().await;
        migrator(27).await.run(&pool).await.unwrap();
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let walk = habit(&pool, WS, "Walk").await;
        let routine = event(&pool, WS, "Daily", true).await;
        link(&pool, WS, &walk, &routine).await.unwrap();
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(
            titles(&for_habit(&pool, WS, &walk).await.unwrap()),
            ["Daily"]
        );
        pool.close().await;
    });
}
