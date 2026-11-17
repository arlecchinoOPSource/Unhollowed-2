use super::*;
use crate::scheduling::{create_event, list_items, ItemRange};
use crate::test_support::{migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE};

fn rule(freq: &str, interval: i64, count: Option<i64>, until: Option<&str>) -> Option<RepeatRule> {
    Some(RepeatRule {
        freq: freq.into(),
        interval,
        count,
        until: until.map(Into::into),
    })
}

fn timed(
    title: &str,
    zone: &str,
    start: &str,
    end: &str,
    repeat: Option<RepeatRule>,
) -> EventInput {
    EventInput {
        title: title.into(),
        time_zone: Some(zone.into()),
        start: Some(start.into()),
        end: Some(end.into()),
        repeat,
        ..Default::default()
    }
}

fn dated(title: &str, start: &str, end: &str, repeat: Option<RepeatRule>) -> EventInput {
    EventInput {
        title: title.into(),
        all_day: true,
        start_date: Some(start.into()),
        end_date: Some(end.into()),
        repeat,
        ..Default::default()
    }
}

async fn items(pool: &SqlitePool, from: &str, to: &str, zone: &str) -> Vec<CalendarItem> {
    list_items(
        pool,
        DEFAULT_WORKSPACE,
        ItemRange {
            from: from.into(),
            to: to.into(),
            time_zone: zone.into(),
        },
    )
    .await
    .unwrap()
    .items
}

/// `(occurrence key, start)` for each item: the date or viewer wall clock.
async fn starts(pool: &SqlitePool, from: &str, to: &str, zone: &str) -> Vec<(String, String)> {
    items(pool, from, to, zone)
        .await
        .into_iter()
        .map(|item| {
            (
                item.occurrence.unwrap_or_default(),
                item.start_date.or(item.start).unwrap_or_default(),
            )
        })
        .collect()
}

fn keys(list: &[(String, String)]) -> Vec<&str> {
    list.iter().map(|(key, _)| key.as_str()).collect()
}

#[test]
fn expands_intervals_and_limits_only_in_the_window() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        // Every other day, five times.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            dated(
                "Run",
                "2026-11-02",
                "2026-11-03",
                rule("daily", 2, Some(5), None),
            ),
        )
        .await
        .unwrap();
        let november = starts(&pool, "2026-11-01", "2026-12-01", "UTC").await;
        assert_eq!(
            keys(&november),
            [
                "2026-11-02",
                "2026-11-04",
                "2026-11-06",
                "2026-11-08",
                "2026-11-10"
            ]
        );
        // A window inside the series sees only its own occurrences.
        assert_eq!(
            keys(&starts(&pool, "2026-11-05", "2026-11-09", "UTC").await),
            ["2026-11-06", "2026-11-08"]
        );

        // Weekly, open-ended, from years ago: only the window is expanded.
        let standup = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed(
                "Standup",
                "UTC",
                "2020-01-06T09:00",
                "2020-01-06T09:15",
                rule("weekly", 1, None, None),
            ),
        )
        .await
        .unwrap();
        let week = items(&pool, "2030-06-03", "2030-06-10", "UTC").await;
        let standups: Vec<_> = week.iter().filter(|item| item.title == "Standup").collect();
        assert_eq!(standups.len(), 1);
        assert_eq!(standups[0].start.as_deref(), Some("2030-06-03T09:00"));
        assert_eq!(standups[0].event_id.as_deref(), Some(standup.id.as_str()));
        assert_eq!(standups[0].id, format!("{}:2030-06-03T09:00", standup.id));
        assert!(standups[0].recurring);

        // Monthly until a date, inclusive.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            dated(
                "Rent",
                "2026-01-15",
                "2026-01-16",
                rule("monthly", 1, None, Some("2026-04-15")),
            ),
        )
        .await
        .unwrap();
        let rent: Vec<_> = items(&pool, "2026-01-01", "2026-12-31", "UTC")
            .await
            .into_iter()
            .filter(|item| item.title == "Rent")
            .map(|item| item.start_date.unwrap())
            .collect();
        assert_eq!(
            rent,
            ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]
        );
    });
}

#[test]
fn monthly_and_yearly_rules_skip_missing_days() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        // The 31st happens only in 31-day months, and the count counts real ones.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            dated(
                "Close",
                "2026-01-31",
                "2026-02-01",
                rule("monthly", 1, Some(4), None),
            ),
        )
        .await
        .unwrap();
        // 29 February only in leap years.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            dated(
                "Leap",
                "2024-02-29",
                "2024-03-01",
                rule("yearly", 1, None, None),
            ),
        )
        .await
        .unwrap();
        let close: Vec<_> = items(&pool, "2026-01-01", "2026-12-31", "UTC")
            .await
            .into_iter()
            .filter(|item| item.title == "Close")
            .map(|item| item.start_date.unwrap())
            .collect();
        assert_eq!(
            close,
            ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]
        );
        let leap_in = |from: &'static str, to: &'static str| {
            let pool = pool.clone();
            async move {
                items(&pool, from, to, "UTC")
                    .await
                    .into_iter()
                    .filter(|item| item.title == "Leap")
                    .map(|item| item.start_date.unwrap())
                    .collect::<Vec<_>>()
            }
        };
        assert!(leap_in("2025-02-01", "2025-04-01").await.is_empty());
        assert!(leap_in("2027-02-01", "2027-04-01").await.is_empty());
        let leap = leap_in("2028-02-01", "2028-04-01").await;
        assert_eq!(leap, ["2028-02-29"]);
        // Every third month from 31 January: April has 30 days, so July is next.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            dated(
                "Quarter",
                "2026-01-31",
                "2026-02-01",
                rule("monthly", 3, Some(3), None),
            ),
        )
        .await
        .unwrap();
        let quarter: Vec<_> = items(&pool, "2026-01-01", "2027-01-01", "UTC")
            .await
            .into_iter()
            .filter(|item| item.title == "Quarter")
            .map(|item| item.start_date.unwrap())
            .collect();
        assert_eq!(quarter, ["2026-01-31", "2026-07-31", "2026-10-31"]);
    });
}

#[test]
fn timed_series_keep_their_wall_clock_across_daylight_saving() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let zone = "America/New_York";
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed(
                "Sync",
                zone,
                "2026-10-26T09:00",
                "2026-10-26T10:00",
                rule("weekly", 1, Some(3), None),
            ),
        )
        .await
        .unwrap();
        let sync = items(&pool, "2026-10-26", "2026-11-10", "UTC").await;
        let instants: Vec<_> = sync
            .iter()
            .map(|item| item.start_at.clone().unwrap())
            .collect();
        // 09:00 EDT, then 09:00 EST after 1 November.
        assert_eq!(
            instants,
            [
                "2026-10-26T13:00:00Z",
                "2026-11-02T14:00:00Z",
                "2026-11-09T14:00:00Z"
            ]
        );
        assert!(sync
            .iter()
            .all(|item| item.local_start.as_deref().unwrap().ends_with("T09:00")));

        // A daily 02:30 meets the March gap and resolves forward to 03:30.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed(
                "Night",
                zone,
                "2026-03-07T02:30",
                "2026-03-07T03:00",
                rule("daily", 1, Some(3), None),
            ),
        )
        .await
        .unwrap();
        let night = starts(&pool, "2026-03-07", "2026-03-10", zone).await;
        assert_eq!(
            night,
            [
                ("2026-03-07T02:30".into(), "2026-03-07T02:30".into()),
                ("2026-03-08T02:30".into(), "2026-03-08T03:30".into()),
                ("2026-03-09T02:30".into(), "2026-03-09T02:30".into()),
            ]
        );
        // Its start moved past its end, so it keeps its 30 minutes: 03:30–04:00.
        let gap_day = items(&pool, "2026-03-08", "2026-03-09", zone).await;
        let night = gap_day.iter().find(|item| item.title == "Night").unwrap();
        assert_eq!(night.end.as_deref(), Some("2026-03-08T04:00"));
    });
}

#[test]
fn occurrence_changes_keep_identity_and_survive_restart() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("occurrence-restart");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let series = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed(
                "Class",
                "UTC",
                "2026-11-02T18:00",
                "2026-11-02T19:00",
                rule("weekly", 1, None, None),
            ),
        )
        .await
        .unwrap();
        // Move 9 November to 12 November, rename it, and cancel 16 November.
        update_occurrence(
            &pool,
            DEFAULT_WORKSPACE,
            &series.id,
            "2026-11-09T18:00",
            timed(
                "Make-up class",
                "UTC",
                "2026-11-12T18:00",
                "2026-11-12T19:30",
                None,
            ),
        )
        .await
        .unwrap();
        cancel_occurrence(&pool, DEFAULT_WORKSPACE, &series.id, "2026-11-16T18:00")
            .await
            .unwrap();
        pool.close().await;

        let pool = database.open().await;
        let november = items(&pool, "2026-11-01", "2026-12-01", "UTC").await;
        let summary: Vec<_> = november
            .iter()
            .map(|item| {
                (
                    item.occurrence.as_deref().unwrap(),
                    item.start.as_deref().unwrap(),
                    item.title.as_str(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("2026-11-02T18:00", "2026-11-02T18:00", "Class"),
                ("2026-11-09T18:00", "2026-11-12T18:00", "Make-up class"),
                ("2026-11-23T18:00", "2026-11-23T18:00", "Class"),
                ("2026-11-30T18:00", "2026-11-30T18:00", "Class"),
            ]
        );
        // A moved occurrence appears in a window that holds only its new day.
        assert_eq!(
            keys(&starts(&pool, "2026-11-12", "2026-11-13", "UTC").await),
            ["2026-11-09T18:00"]
        );
        assert!(starts(&pool, "2026-11-09", "2026-11-10", "UTC")
            .await
            .is_empty());

        // Restoring undoes the change.
        restore_occurrence(&pool, DEFAULT_WORKSPACE, &series.id, "2026-11-16T18:00")
            .await
            .unwrap();
        assert_eq!(
            keys(&starts(&pool, "2026-11-16", "2026-11-17", "UTC").await),
            ["2026-11-16T18:00"]
        );

        // Unknown occurrences and single events are refused.
        assert_eq!(
            cancel_occurrence(&pool, DEFAULT_WORKSPACE, &series.id, "2026-11-10T18:00").await,
            Err(SchedulingError::OccurrenceNotFound)
        );
        let single = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            dated("Once", "2026-11-03", "2026-11-04", None),
        )
        .await
        .unwrap();
        assert_eq!(
            cancel_occurrence(&pool, DEFAULT_WORKSPACE, &single.id, "2026-11-03").await,
            Err(SchedulingError::NotRecurring)
        );
        assert_eq!(
            update_occurrence(
                &pool,
                DEFAULT_WORKSPACE,
                &series.id,
                "2026-11-23T18:00",
                dated("Class", "2026-11-23", "2026-11-24", None),
            )
            .await,
            Err(SchedulingError::OccurrenceKind)
        );
        assert_eq!(
            update_occurrence(
                &pool,
                DEFAULT_WORKSPACE,
                &series.id,
                "2026-11-23T18:00",
                timed(
                    "Class",
                    "Europe/Paris",
                    "2026-11-23T18:00",
                    "2026-11-23T19:00",
                    None
                ),
            )
            .await,
            Err(SchedulingError::InvalidTimeZone)
        );
        pool.close().await;
    });
}

#[test]
fn whole_series_edits_keep_unrelated_changes() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let series = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            dated(
                "Water plants",
                "2026-11-02",
                "2026-11-03",
                rule("weekly", 1, Some(6), None),
            ),
        )
        .await
        .unwrap();
        cancel_occurrence(&pool, DEFAULT_WORKSPACE, &series.id, "2026-11-09")
            .await
            .unwrap();
        update_occurrence(
            &pool,
            DEFAULT_WORKSPACE,
            &series.id,
            "2026-11-16",
            dated("Water plants", "2026-11-17", "2026-11-18", None),
        )
        .await
        .unwrap();
        // Renaming the series keeps both changes.
        crate::scheduling::events::update(
            &pool,
            DEFAULT_WORKSPACE,
            &series.id,
            dated(
                "Water the plants",
                "2026-11-02",
                "2026-11-03",
                rule("weekly", 1, Some(6), None),
            ),
        )
        .await
        .unwrap();
        let list = starts(&pool, "2026-11-01", "2026-12-15", "UTC").await;
        assert_eq!(
            list.iter()
                .map(|(_, start)| start.as_str())
                .collect::<Vec<_>>(),
            [
                "2026-11-02",
                "2026-11-17",
                "2026-11-23",
                "2026-11-30",
                "2026-12-07"
            ]
        );
        // Moving the series by a day leaves those dates without occurrences,
        // so their changes are removed.
        crate::scheduling::events::update(
            &pool,
            DEFAULT_WORKSPACE,
            &series.id,
            dated(
                "Water the plants",
                "2026-11-03",
                "2026-11-04",
                rule("weekly", 1, Some(6), None),
            ),
        )
        .await
        .unwrap();
        let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM event_exceptions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
        assert_eq!(
            starts(&pool, "2026-11-01", "2026-12-15", "UTC").await.len(),
            6
        );
    });
}

#[test]
fn splits_this_and_following_and_carries_matching_changes() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let series = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed(
                "Review",
                "UTC",
                "2026-11-02T10:00",
                "2026-11-02T11:00",
                rule("weekly", 1, Some(6), None),
            ),
        )
        .await
        .unwrap();
        cancel_occurrence(&pool, DEFAULT_WORKSPACE, &series.id, "2026-11-30T10:00")
            .await
            .unwrap();
        cancel_occurrence(&pool, DEFAULT_WORKSPACE, &series.id, "2026-11-09T10:00")
            .await
            .unwrap();

        // From 16 November: an hour later, renamed, same rule, three left.
        let result = split(
            &pool,
            DEFAULT_WORKSPACE,
            &series.id,
            "2026-11-16T10:00",
            timed(
                "Review (late)",
                "UTC",
                "2026-11-16T11:00",
                "2026-11-16T12:00",
                rule("weekly", 1, Some(4), None),
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            result.series.repeat_count,
            Some(2),
            "two occurrences stay in the original"
        );
        let created = result.created.unwrap();
        assert_ne!(created.id, series.id);
        assert_eq!((result.kept_changes, result.dropped_changes), (1, 0));
        let list = items(&pool, "2026-11-01", "2026-12-31", "UTC").await;
        let summary: Vec<_> = list
            .iter()
            .map(|item| (item.start.as_deref().unwrap(), item.title.as_str()))
            .collect();
        // 9 November stays canceled, and 30 November's cancellation moved to 11:00.
        assert_eq!(
            summary,
            [
                ("2026-11-02T10:00", "Review"),
                ("2026-11-16T11:00", "Review (late)"),
                ("2026-11-23T11:00", "Review (late)"),
                ("2026-12-07T11:00", "Review (late)"),
            ]
        );

        // A split that changes the frequency cannot match later changes.
        let monthly = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            dated(
                "Pay",
                "2027-01-01",
                "2027-01-02",
                rule("weekly", 1, None, None),
            ),
        )
        .await
        .unwrap();
        cancel_occurrence(&pool, DEFAULT_WORKSPACE, &monthly.id, "2027-01-29")
            .await
            .unwrap();
        let result = split(
            &pool,
            DEFAULT_WORKSPACE,
            &monthly.id,
            "2027-01-15",
            dated(
                "Pay",
                "2027-01-15",
                "2027-01-16",
                rule("monthly", 1, None, None),
            ),
        )
        .await
        .unwrap();
        assert_eq!((result.kept_changes, result.dropped_changes), (0, 1));
        assert_eq!(result.series.repeat_until.as_deref(), Some("2027-01-14"));

        // Splitting at the first occurrence edits the whole series.
        let first = split(
            &pool,
            DEFAULT_WORKSPACE,
            &created.id,
            "2026-11-16T11:00",
            timed(
                "Review",
                "UTC",
                "2026-11-16T11:00",
                "2026-11-16T12:00",
                rule("weekly", 1, Some(4), None),
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            (first.created, first.series.title.as_str()),
            (None, "Review")
        );
    });
}

#[test]
fn ending_a_series_deletes_this_and_following() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let series = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            dated(
                "Gym",
                "2026-11-02",
                "2026-11-03",
                rule("daily", 1, None, None),
            ),
        )
        .await
        .unwrap();
        cancel_occurrence(&pool, DEFAULT_WORKSPACE, &series.id, "2026-11-06")
            .await
            .unwrap();
        let ended = end_series(&pool, DEFAULT_WORKSPACE, &series.id, "2026-11-05")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ended.repeat_until.as_deref(), Some("2026-11-04"));
        assert_eq!(
            keys(&starts(&pool, "2026-11-01", "2026-11-30", "UTC").await),
            ["2026-11-02", "2026-11-03", "2026-11-04"]
        );
        let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM event_exceptions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 0, "the later cancellation went with them");
        // From the first occurrence, the whole event goes.
        assert_eq!(
            end_series(&pool, DEFAULT_WORKSPACE, &series.id, "2026-11-02").await,
            Ok(None)
        );
        assert!(starts(&pool, "2026-11-01", "2026-11-30", "UTC")
            .await
            .is_empty());
    });
}

#[test]
fn rejects_invalid_rules() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for repeat in [
            rule("hourly", 1, None, None),
            rule("daily", 0, None, None),
            rule("daily", 100, None, None),
            rule("daily", 1, Some(0), None),
            rule("daily", 1, Some(1000), None),
            rule("daily", 1, Some(3), Some("2026-12-01")),
            rule("daily", 1, None, Some("2026-11-01")),
            rule("daily", 1, None, Some("someday")),
        ] {
            assert_eq!(
                create_event(
                    &pool,
                    DEFAULT_WORKSPACE,
                    dated("A", "2026-11-02", "2026-11-03", repeat.clone())
                )
                .await,
                Err(SchedulingError::InvalidRepeat),
                "{repeat:?}"
            );
        }
        // The database refuses an incomplete rule written around Rust.
        let calendar = crate::scheduling::calendars_of(&pool, DEFAULT_WORKSPACE)
            .await
            .unwrap()[0]
            .id
            .clone();
        let direct = sqlx::query(
            "INSERT INTO events (id, workspace_id, calendar_id, title, all_day, start_date, end_date, repeat_freq)
             VALUES ('x', ?, ?, 'A', 1, '2026-11-02', '2026-11-03', 'daily')",
        )
        .bind(DEFAULT_WORKSPACE)
        .bind(calendar)
        .execute(&pool)
        .await;
        assert!(direct.is_err());
    });
}
