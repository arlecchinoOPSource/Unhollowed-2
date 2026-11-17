use super::*;
use crate::scheduling::{calendars_of, create_event, list_items, EventInput, ItemRange};
use crate::test_support::{
    add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

fn input(name: &str, color: &str) -> CalendarInput {
    CalendarInput {
        name: name.into(),
        description: Some(format!("{name} commitments")),
        color: color.into(),
    }
}

fn event(title: &str, calendar: Option<&str>) -> EventInput {
    EventInput {
        title: title.into(),
        calendar_id: calendar.map(Into::into),
        all_day: true,
        start_date: Some("2026-11-18".into()),
        end_date: Some("2026-11-19".into()),
        ..Default::default()
    }
}

async fn visible_titles(pool: &SqlitePool) -> Vec<String> {
    list_items(
        pool,
        DEFAULT_WORKSPACE,
        ItemRange {
            from: "2026-11-18".into(),
            to: "2026-11-19".into(),
            time_zone: "UTC".into(),
        },
    )
    .await
    .unwrap()
    .items
    .into_iter()
    .map(|item| item.title)
    .collect()
}

#[test]
fn settings_survive_a_restart() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("calendar-restart");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let work = create(&pool, DEFAULT_WORKSPACE, input("Work", "teal"))
            .await
            .unwrap();
        set_hidden(&pool, DEFAULT_WORKSPACE, &work.id, true)
            .await
            .unwrap();
        set_default(&pool, DEFAULT_WORKSPACE, &work.id)
            .await
            .unwrap();
        pool.close().await;

        let pool = database.open().await;
        let calendars = calendars_of(&pool, DEFAULT_WORKSPACE).await.unwrap();
        let work = calendars.iter().find(|c| c.name == "Work").unwrap();
        assert_eq!(
            (
                work.color.as_str(),
                work.description.as_deref(),
                work.hidden,
                work.is_default
            ),
            ("teal", Some("Work commitments"), true, true)
        );
        // Still exactly one default.
        assert_eq!(calendars.iter().filter(|c| c.is_default).count(), 1);
        pool.close().await;
    });
}

#[test]
fn archiving_keeps_events_and_always_leaves_an_active_default() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let personal = calendars_of(&pool, DEFAULT_WORKSPACE).await.unwrap()[0].clone();
        let work = create(&pool, DEFAULT_WORKSPACE, input("Work", "red"))
            .await
            .unwrap();
        let standup = create_event(&pool, DEFAULT_WORKSPACE, event("Standup", Some(&work.id)))
            .await
            .unwrap();
        create_event(&pool, DEFAULT_WORKSPACE, event("Dentist", None))
            .await
            .unwrap();

        // The default needs a valid replacement: none, itself, or an archived one.
        for replacement in [None, Some(personal.id.as_str()), Some("missing")] {
            assert_eq!(
                archive(&pool, DEFAULT_WORKSPACE, &personal.id, replacement).await,
                Err(SchedulingError::ReplacementRequired)
            );
        }
        let archived_work = archive(&pool, DEFAULT_WORKSPACE, &work.id, None)
            .await
            .unwrap();
        assert!(archived_work.archived_at.is_some());
        assert_eq!(
            archive(&pool, DEFAULT_WORKSPACE, &personal.id, Some(&work.id)).await,
            Err(SchedulingError::ReplacementRequired)
        );
        assert_eq!(
            set_default(&pool, DEFAULT_WORKSPACE, &work.id).await,
            Err(SchedulingError::CalendarArchived)
        );
        // Archived calendars keep their events out of views, and take no new ones.
        assert_eq!(visible_titles(&pool).await, ["Dentist"]);
        assert_eq!(
            create_event(&pool, DEFAULT_WORKSPACE, event("Late", Some(&work.id))).await,
            Err(SchedulingError::CalendarNotFound)
        );

        // Restoring brings the events back untouched.
        restore(&pool, DEFAULT_WORKSPACE, &work.id).await.unwrap();
        assert_eq!(visible_titles(&pool).await, ["Dentist", "Standup"]);
        let kept = crate::scheduling::get_event(&pool, DEFAULT_WORKSPACE, &standup.id)
            .await
            .unwrap();
        assert_eq!(kept, standup);

        // Archiving the default with a replacement moves the default first.
        let personal = archive(&pool, DEFAULT_WORKSPACE, &personal.id, Some(&work.id))
            .await
            .unwrap();
        assert!(!personal.is_default && personal.archived_at.is_some());
        let calendars = calendars_of(&pool, DEFAULT_WORKSPACE).await.unwrap();
        let defaults: Vec<_> = calendars.iter().filter(|c| c.is_default).collect();
        assert_eq!(defaults.len(), 1);
        assert_eq!(defaults[0].id, work.id);
        // New events without a calendar go to the new default.
        let next = create_event(&pool, DEFAULT_WORKSPACE, event("Next", None))
            .await
            .unwrap();
        assert_eq!(next.calendar_id, work.id);
    });
}

#[test]
fn hiding_a_calendar_hides_only_its_events() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let work = create(&pool, DEFAULT_WORKSPACE, input("Work", "red"))
            .await
            .unwrap();
        create_event(&pool, DEFAULT_WORKSPACE, event("Standup", Some(&work.id)))
            .await
            .unwrap();
        create_event(&pool, DEFAULT_WORKSPACE, event("Dentist", None))
            .await
            .unwrap();
        set_hidden(&pool, DEFAULT_WORKSPACE, &work.id, true)
            .await
            .unwrap();
        assert_eq!(visible_titles(&pool).await, ["Dentist"]);
        set_hidden(&pool, DEFAULT_WORKSPACE, &work.id, false)
            .await
            .unwrap();
        assert_eq!(visible_titles(&pool).await, ["Dentist", "Standup"]);
    });
}

#[test]
fn moving_an_event_keeps_its_identity_and_enforces_ownership() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let work = create(&pool, DEFAULT_WORKSPACE, input("Work", "red"))
            .await
            .unwrap();
        let foreign = create(&pool, OTHER_WORKSPACE, input("Theirs", "red"))
            .await
            .unwrap();
        let standup = create_event(&pool, DEFAULT_WORKSPACE, event("Standup", None))
            .await
            .unwrap();

        let moved = move_event(&pool, DEFAULT_WORKSPACE, &standup.id, &work.id)
            .await
            .unwrap();
        assert_eq!(moved.id, standup.id);
        assert_eq!(moved.calendar_id, work.id);
        assert_eq!(
            (&moved.title, &moved.start_date, &moved.created_at),
            (&standup.title, &standup.start_date, &standup.created_at)
        );

        assert_eq!(
            move_event(&pool, DEFAULT_WORKSPACE, &standup.id, &foreign.id).await,
            Err(SchedulingError::CalendarNotFound)
        );
        let foreign_event = create_event(&pool, OTHER_WORKSPACE, event("Theirs", None))
            .await
            .unwrap();
        assert_eq!(
            move_event(&pool, DEFAULT_WORKSPACE, &foreign_event.id, &work.id).await,
            Err(SchedulingError::NotFound)
        );
        let personal = calendars_of(&pool, DEFAULT_WORKSPACE)
            .await
            .unwrap()
            .into_iter()
            .find(|c| c.is_default)
            .unwrap();
        archive(&pool, DEFAULT_WORKSPACE, &personal.id, Some(&work.id))
            .await
            .unwrap();
        assert_eq!(
            move_event(&pool, DEFAULT_WORKSPACE, &standup.id, &personal.id).await,
            Err(SchedulingError::CalendarNotFound)
        );
        // Editing another workspace's calendar is refused too.
        assert_eq!(
            update(&pool, DEFAULT_WORKSPACE, &foreign.id, input("Mine", "red")).await,
            Err(SchedulingError::CalendarNotFound)
        );
    });
}

#[test]
fn validates_names_colors_and_duplicates() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        assert_eq!(
            create(&pool, DEFAULT_WORKSPACE, input("  ", "red")).await,
            Err(SchedulingError::InvalidName)
        );
        assert_eq!(
            create(&pool, DEFAULT_WORKSPACE, input("Work", "magenta")).await,
            Err(SchedulingError::InvalidColor)
        );
        // "Personal" is the seeded default, so its name is taken in any case.
        assert_eq!(
            create(&pool, DEFAULT_WORKSPACE, input("personal", "red")).await,
            Err(SchedulingError::DuplicateName)
        );
        let work = create(&pool, DEFAULT_WORKSPACE, input("  Work  ", "red"))
            .await
            .unwrap();
        assert_eq!(work.name, "Work");
        // Renaming to its own name in another case is allowed.
        let renamed = update(&pool, DEFAULT_WORKSPACE, &work.id, input("WORK", "green"))
            .await
            .unwrap();
        assert_eq!(
            (renamed.name.as_str(), renamed.color.as_str()),
            ("WORK", "green")
        );
        assert!(!renamed.is_default);
    });
}
