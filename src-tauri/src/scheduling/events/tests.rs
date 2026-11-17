use super::*;
use crate::scheduling::{calendars, create_event, get_event};
use crate::test_support::{
    add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

fn timed(title: &str) -> EventInput {
    EventInput {
        title: title.into(),
        time_zone: Some("Europe/Paris".into()),
        start: Some("2026-11-18T09:00".into()),
        end: Some("2026-11-18T10:30".into()),
        ..Default::default()
    }
}

fn calendar(name: &str) -> calendars::CalendarInput {
    calendars::CalendarInput {
        name: name.into(),
        description: None,
        color: "green".into(),
    }
}

#[test]
fn edits_between_timed_and_all_day_and_keeps_them_after_restart() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("event-restart");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let event = create_event(&pool, DEFAULT_WORKSPACE, timed("Review"))
            .await
            .unwrap();
        let all_day = update(
            &pool,
            DEFAULT_WORKSPACE,
            &event.id,
            EventInput {
                title: "Offsite".into(),
                description: "Bring slides".into(),
                location: Some("  Lyon  ".into()),
                url: Some("https://example.com/agenda?day=1".into()),
                all_day: true,
                start_date: Some("2026-11-18".into()),
                end_date: Some("2026-11-21".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(all_day.id, event.id);
        assert_eq!(all_day.location.as_deref(), Some("Lyon"));
        assert_eq!(
            (all_day.start_local, all_day.start_at),
            (None, None),
            "timed fields are cleared"
        );
        pool.close().await;

        let pool = database.open().await;
        let stored = get_event(&pool, DEFAULT_WORKSPACE, &event.id)
            .await
            .unwrap();
        assert_eq!(
            (
                stored.all_day,
                stored.start_date.as_deref(),
                stored.end_date.as_deref()
            ),
            (true, Some("2026-11-18"), Some("2026-11-21"))
        );
        let back = update(&pool, DEFAULT_WORKSPACE, &event.id, timed("Review"))
            .await
            .unwrap();
        assert_eq!(
            (back.start_date, back.end_at.as_deref()),
            (None, Some("2026-11-18T09:30:00Z"))
        );
        pool.close().await;
    });
}

#[test]
fn reassigns_calendars_only_within_the_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let work = calendars::create(&pool, DEFAULT_WORKSPACE, calendar("Work"))
            .await
            .unwrap();
        let theirs = calendars::create(&pool, OTHER_WORKSPACE, calendar("Theirs"))
            .await
            .unwrap();
        let event = create_event(&pool, DEFAULT_WORKSPACE, timed("Plan"))
            .await
            .unwrap();
        let moved = update(
            &pool,
            DEFAULT_WORKSPACE,
            &event.id,
            EventInput {
                calendar_id: Some(work.id.clone()),
                ..timed("Plan")
            },
        )
        .await
        .unwrap();
        assert_eq!(
            (moved.id.as_str(), moved.calendar_id.as_str()),
            (event.id.as_str(), work.id.as_str())
        );
        assert_eq!(
            update(
                &pool,
                DEFAULT_WORKSPACE,
                &event.id,
                EventInput {
                    calendar_id: Some(theirs.id.clone()),
                    ..timed("Plan")
                },
            )
            .await,
            Err(SchedulingError::CalendarNotFound)
        );
        // Another workspace cannot edit, duplicate, or delete it.
        assert_eq!(
            update(&pool, OTHER_WORKSPACE, &event.id, timed("Taken")).await,
            Err(SchedulingError::NotFound)
        );
        assert_eq!(
            duplicate(&pool, OTHER_WORKSPACE, &event.id).await,
            Err(SchedulingError::NotFound)
        );
        assert_eq!(
            delete(&pool, OTHER_WORKSPACE, &event.id).await,
            Err(SchedulingError::NotFound)
        );
        // An event in an archived calendar can still be edited where it is.
        let personal = crate::scheduling::calendars_of(&pool, DEFAULT_WORKSPACE)
            .await
            .unwrap()
            .into_iter()
            .find(|c| c.is_default)
            .unwrap();
        calendars::archive(&pool, DEFAULT_WORKSPACE, &work.id, None)
            .await
            .unwrap();
        let edited = update(&pool, DEFAULT_WORKSPACE, &event.id, timed("Plan B"))
            .await
            .unwrap();
        assert_eq!(edited.calendar_id, work.id);
        assert_eq!(
            duplicate(&pool, DEFAULT_WORKSPACE, &event.id).await,
            Err(SchedulingError::CalendarNotFound),
            "archived calendars take no new events"
        );
        let back = update(
            &pool,
            DEFAULT_WORKSPACE,
            &event.id,
            EventInput {
                calendar_id: Some(personal.id.clone()),
                ..timed("Plan B")
            },
        )
        .await
        .unwrap();
        assert_eq!(back.calendar_id, personal.id);
    });
}

#[test]
fn duplicates_and_deletes() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let event = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            EventInput {
                location: Some("Room 2".into()),
                url: Some("http://intranet.local/plan".into()),
                ..timed("Plan")
            },
        )
        .await
        .unwrap();
        let copy = duplicate(&pool, DEFAULT_WORKSPACE, &event.id)
            .await
            .unwrap();
        assert_ne!(copy.id, event.id);
        assert_eq!(
            Event {
                id: event.id.clone(),
                created_at: event.created_at.clone(),
                updated_at: event.updated_at.clone(),
                ..copy.clone()
            },
            event
        );
        delete(&pool, DEFAULT_WORKSPACE, &event.id).await.unwrap();
        assert_eq!(
            get_event(&pool, DEFAULT_WORKSPACE, &event.id).await,
            Err(SchedulingError::NotFound)
        );
        assert_eq!(
            delete(&pool, DEFAULT_WORKSPACE, &event.id).await,
            Err(SchedulingError::NotFound)
        );
        assert!(get_event(&pool, DEFAULT_WORKSPACE, &copy.id).await.is_ok());
    });
}

#[test]
fn accepts_only_web_addresses_and_short_locations() {
    for url in [
        "https://example.com",
        "http://localhost:8080/path?q=1#top",
        "HTTPS://Example.COM/A",
        "https://user@host.example/x",
        "https://[::1]/",
    ] {
        assert!(crate::scheduling::valid_url(url), "{url}");
    }
    for url in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "ftp://example.com",
        "https://",
        "https:// example.com",
        "https://exa mple.com",
        "https://example.com/\u{7}",
        "example.com",
        "https://ex_ample.com",
    ] {
        assert!(!crate::scheduling::valid_url(url), "{url}");
    }
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for (input, error) in [
            (
                EventInput {
                    url: Some("javascript:alert(1)".into()),
                    ..timed("A")
                },
                SchedulingError::InvalidUrl,
            ),
            (
                EventInput {
                    location: Some("x".repeat(201)),
                    ..timed("A")
                },
                SchedulingError::InvalidLocation,
            ),
            (
                EventInput {
                    end: Some("2026-11-18T08:00".into()),
                    ..timed("A")
                },
                SchedulingError::InvalidRange,
            ),
        ] {
            assert_eq!(
                create_event(&pool, DEFAULT_WORKSPACE, input).await,
                Err(error)
            );
        }
        // Blank optional fields are stored as absent.
        let event = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            EventInput {
                location: Some("   ".into()),
                url: Some("".into()),
                ..timed("A")
            },
        )
        .await
        .unwrap();
        assert_eq!((event.location, event.url), (None, None));
    });
}

#[test]
fn a_failed_edit_leaves_the_saved_event_unchanged() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let event = create_event(&pool, DEFAULT_WORKSPACE, timed("Keep"))
            .await
            .unwrap();
        // Invalid input is refused before writing.
        assert_eq!(
            update(
                &pool,
                DEFAULT_WORKSPACE,
                &event.id,
                EventInput {
                    start: Some("2026-02-30T09:00".into()),
                    ..timed("Changed")
                },
            )
            .await,
            Err(SchedulingError::InvalidTime)
        );
        // A storage failure mid-write rolls back.
        sqlx::query(
            "CREATE TEMP TRIGGER refuse BEFORE UPDATE ON events
             BEGIN SELECT RAISE(ABORT, 'refused'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            update(&pool, DEFAULT_WORKSPACE, &event.id, timed("Changed")).await,
            Err(SchedulingError::StorageFailed)
        );
        assert_eq!(
            get_event(&pool, DEFAULT_WORKSPACE, &event.id)
                .await
                .unwrap(),
            event
        );
    });
}
