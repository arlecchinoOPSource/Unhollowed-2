use super::*;
use crate::scheduling::{
    create_event, events, recurrence::cancel_occurrence, recurrence::RepeatRule, EventInput,
};
use crate::test_support::{
    add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

fn at(value: &str) -> Timestamp {
    value.parse().unwrap()
}

async fn event(pool: &SqlitePool, title: &str, zone: &str, start: &str, end: &str) -> String {
    create_event(
        pool,
        DEFAULT_WORKSPACE,
        EventInput {
            title: title.into(),
            time_zone: Some(zone.into()),
            start: Some(start.into()),
            end: Some(end.into()),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .id
}

async fn claim(pool: &SqlitePool, now: &str) -> Vec<DueReminder> {
    claim_due(pool, DEFAULT_WORKSPACE, at(now)).await.unwrap()
}

#[test]
fn a_reminder_fires_once_between_its_time_and_the_start() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let id = event(
            &pool,
            "Dentist",
            "UTC",
            "2026-11-18T10:00",
            "2026-11-18T11:00",
        )
        .await;
        set_reminder(&pool, DEFAULT_WORKSPACE, &id, Some(15))
            .await
            .unwrap();

        // Equal to the reminder time is due, and earlier is not.
        assert!(claim(&pool, "2026-11-18T09:44:59Z").await.is_empty());
        let due = claim(&pool, "2026-11-18T09:45:00Z").await;
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].title, "Dentist");
        assert_eq!(due[0].start_at, "2026-11-18T10:00:00Z");
        // Asking again, or later, does not repeat it.
        assert!(claim(&pool, "2026-11-18T09:45:30Z").await.is_empty());
        assert!(claim(&pool, "2026-11-18T09:59:00Z").await.is_empty());
    });
}

#[test]
fn a_reminder_missed_past_the_start_is_dropped_and_a_late_one_still_fires() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let early = event(
            &pool,
            "Early",
            "UTC",
            "2026-11-18T10:00",
            "2026-11-18T11:00",
        )
        .await;
        let late = event(&pool, "Late", "UTC", "2026-11-18T12:00", "2026-11-18T13:00").await;
        for id in [&early, &late] {
            set_reminder(&pool, DEFAULT_WORKSPACE, id, Some(30))
                .await
                .unwrap();
        }
        // The app was asleep from 09:00 to 10:10. Early has started, so it is
        // dropped. Late is not due yet.
        assert!(claim(&pool, "2026-11-18T10:10:00Z").await.is_empty());
        // Waking 5 minutes before Late starts still delivers it, once.
        let due = claim(&pool, "2026-11-18T11:55:00Z").await;
        assert_eq!(
            due.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
            ["Late"]
        );
    });
}

#[test]
fn editing_moves_the_reminder_and_cancelling_or_clearing_removes_it() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let id = event(&pool, "Call", "UTC", "2026-11-18T10:00", "2026-11-18T11:00").await;
        set_reminder(&pool, DEFAULT_WORKSPACE, &id, Some(10))
            .await
            .unwrap();
        assert_eq!(claim(&pool, "2026-11-18T09:50:00Z").await.len(), 1);

        // Moving the event to 15:00 reminds again for the new time only.
        events::update(
            &pool,
            DEFAULT_WORKSPACE,
            &id,
            EventInput {
                title: "Call".into(),
                time_zone: Some("UTC".into()),
                start: Some("2026-11-18T15:00".into()),
                end: Some("2026-11-18T16:00".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(claim(&pool, "2026-11-18T09:55:00Z").await.is_empty());
        assert_eq!(claim(&pool, "2026-11-18T14:51:00Z").await.len(), 1);

        // Clearing the reminder and deleting the event leave nothing due.
        set_reminder(&pool, DEFAULT_WORKSPACE, &id, None)
            .await
            .unwrap();
        assert_eq!(reminder(&pool, DEFAULT_WORKSPACE, &id).await.unwrap(), None);
        set_reminder(&pool, DEFAULT_WORKSPACE, &id, Some(10))
            .await
            .unwrap();
        events::delete(&pool, DEFAULT_WORKSPACE, &id).await.unwrap();
        assert!(claim(&pool, "2026-11-18T14:55:00Z").await.is_empty());
        let (reminders, deliveries): (i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM event_reminders), (SELECT count(*) FROM reminder_deliveries)",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((reminders, deliveries), (0, 0));
    });
}

#[test]
fn each_occurrence_of_a_repeating_event_is_reminded_and_a_cancelled_one_is_not() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let id = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            EventInput {
                title: "Standup".into(),
                time_zone: Some("UTC".into()),
                start: Some("2026-11-16T09:00".into()),
                end: Some("2026-11-16T09:15".into()),
                repeat: Some(RepeatRule {
                    freq: "daily".into(),
                    interval: 1,
                    count: Some(5),
                    until: None,
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .id;
        set_reminder(&pool, DEFAULT_WORKSPACE, &id, Some(5))
            .await
            .unwrap();
        assert_eq!(claim(&pool, "2026-11-16T08:56:00Z").await.len(), 1);
        assert!(claim(&pool, "2026-11-16T08:58:00Z").await.is_empty());
        cancel_occurrence(&pool, DEFAULT_WORKSPACE, &id, "2026-11-17T09:00")
            .await
            .unwrap();
        assert!(claim(&pool, "2026-11-17T08:56:00Z").await.is_empty());
        let next = claim(&pool, "2026-11-18T08:56:00Z").await;
        assert_eq!(next[0].start_at, "2026-11-18T09:00:00Z");
    });
}

#[test]
fn disabled_reminders_stay_silent_and_resume_when_turned_on() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let id = event(&pool, "Call", "UTC", "2026-11-18T10:00", "2026-11-18T11:00").await;
        set_reminder(&pool, DEFAULT_WORKSPACE, &id, Some(30))
            .await
            .unwrap();
        assert!(enabled(&pool, DEFAULT_WORKSPACE).await.unwrap());
        set_enabled(&pool, DEFAULT_WORKSPACE, false).await.unwrap();
        assert!(claim(&pool, "2026-11-18T09:40:00Z").await.is_empty());
        // Nothing was marked delivered while off.
        set_enabled(&pool, DEFAULT_WORKSPACE, true).await.unwrap();
        assert_eq!(claim(&pool, "2026-11-18T09:50:00Z").await.len(), 1);
    });
}

#[test]
fn reminders_follow_the_events_zone_across_daylight_saving() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        // 03:00 on the spring-forward morning in New York is 07:00 UTC.
        let id = event(
            &pool,
            "Early flight",
            "America/New_York",
            "2026-03-08T03:00",
            "2026-03-08T04:00",
        )
        .await;
        set_reminder(&pool, DEFAULT_WORKSPACE, &id, Some(60))
            .await
            .unwrap();
        assert!(claim(&pool, "2026-03-08T05:59:59Z").await.is_empty());
        let due = claim(&pool, "2026-03-08T06:00:00Z").await;
        assert_eq!(due[0].start_at, "2026-03-08T07:00:00Z");
    });
}

#[test]
fn deliveries_survive_a_restart_and_reminders_stay_in_their_workspace() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("reminders");
        let pool = database.open().await;
        migrator(23).await.run(&pool).await.unwrap();
        let id = event(&pool, "Call", "UTC", "2026-11-18T10:00", "2026-11-18T11:00").await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        set_reminder(&pool, DEFAULT_WORKSPACE, &id, Some(30))
            .await
            .unwrap();
        assert_eq!(claim(&pool, "2026-11-18T09:40:00Z").await.len(), 1);
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert!(claim(&pool, "2026-11-18T09:41:00Z").await.is_empty());

        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        assert_eq!(
            set_reminder(&pool, OTHER_WORKSPACE, &id, Some(5)).await,
            Err(SchedulingError::NotFound)
        );
        assert!(
            claim_due(&pool, OTHER_WORKSPACE, at("2026-11-18T09:58:00Z"))
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            set_reminder(&pool, DEFAULT_WORKSPACE, &id, Some(-1)).await,
            Err(SchedulingError::InvalidReminder)
        );
        assert_eq!(
            set_reminder(&pool, DEFAULT_WORKSPACE, &id, Some(10_081)).await,
            Err(SchedulingError::InvalidReminder)
        );
        pool.close().await;
    });
}
