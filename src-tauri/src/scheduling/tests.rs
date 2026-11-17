use super::*;
use crate::test_support::{
    add_issue, add_issue_before_upgrade, add_workspace, memory_pool, migrated_pool, migrator,
    DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

fn timed(title: &str, zone: &str, start: &str, end: &str) -> EventInput {
    EventInput {
        title: title.into(),
        time_zone: Some(zone.into()),
        start: Some(start.into()),
        end: Some(end.into()),
        ..Default::default()
    }
}

fn all_day(title: &str, start: &str, end: &str) -> EventInput {
    EventInput {
        title: title.into(),
        all_day: true,
        start_date: Some(start.into()),
        end_date: Some(end.into()),
        ..Default::default()
    }
}

fn range(from: &str, to: &str, zone: &str) -> ItemRange {
    ItemRange {
        from: from.into(),
        to: to.into(),
        time_zone: zone.into(),
    }
}

async fn count(pool: &SqlitePool, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
        .fetch_one(pool)
        .await
        .unwrap()
}

#[test]
fn upgrading_keeps_issue_deadlines_and_projects_them_without_event_rows() {
    tauri::async_runtime::block_on(async {
        let pool = memory_pool().await;
        migrator(19).await.run(&pool).await.unwrap();
        let issue = add_issue_before_upgrade(&pool, DEFAULT_WORKSPACE, None).await;
        sqlx::query("UPDATE issues SET due_date = '2026-11-20' WHERE id = ?")
            .bind(&issue)
            .execute(&pool)
            .await
            .unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();

        let (due,): (String,) = sqlx::query_as("SELECT due_date FROM issues WHERE id = ?")
            .bind(&issue)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(due, "2026-11-20");
        let items = list_items(
            &pool,
            DEFAULT_WORKSPACE,
            range("2026-11-16", "2026-11-23", "UTC"),
        )
        .await
        .unwrap()
        .items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, ItemKind::Deadline);
        assert_eq!(items[0].issue_id.as_deref(), Some(issue.as_str()));
        assert_eq!(
            (items[0].start_date.as_deref(), items[0].end_date.as_deref()),
            (Some("2026-11-20"), Some("2026-11-21"))
        );
        // Projection writes nothing, and reading does not create calendars.
        assert_eq!(count(&pool, "events").await, 0);
        assert_eq!(count(&pool, "calendars").await, 0);
    });
}

#[test]
fn deadlines_keep_their_date_in_every_viewer_zone() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let issue = add_issue(&pool, DEFAULT_WORKSPACE, None).await;
        crate::issues::set_due_date(&pool, DEFAULT_WORKSPACE, &issue, Some("2026-12-31"))
            .await
            .unwrap();
        for zone in ["Pacific/Kiritimati", "UTC", "Pacific/Pago_Pago"] {
            let items = list_items(
                &pool,
                DEFAULT_WORKSPACE,
                range("2026-12-31", "2027-01-01", zone),
            )
            .await
            .unwrap()
            .items;
            assert_eq!(items[0].start_date.as_deref(), Some("2026-12-31"), "{zone}");
        }
    });
}

#[test]
fn the_three_item_kinds_have_their_own_storage() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let issue = add_issue(&pool, DEFAULT_WORKSPACE, None).await;
        crate::issues::set_due_date(&pool, DEFAULT_WORKSPACE, &issue, Some("2026-11-18"))
            .await
            .unwrap();
        let meeting = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed(
                "Standup",
                "Europe/Paris",
                "2026-11-18T09:00",
                "2026-11-18T09:30",
            ),
        )
        .await
        .unwrap();
        let trip = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            all_day("Trip", "2026-11-17", "2026-11-20"),
        )
        .await
        .unwrap();
        let block = create_work_block(
            &pool,
            DEFAULT_WORKSPACE,
            WorkBlockInput {
                issue_id: issue.clone(),
                time_zone: "Europe/Paris".into(),
                start: "2026-11-18T14:00".into(),
                end: "2026-11-18T16:00".into(),
            },
        )
        .await
        .unwrap();

        // Each event got the default calendar, created once.
        let calendars = calendars_of(&pool, DEFAULT_WORKSPACE).await.unwrap();
        assert_eq!(calendars.len(), 1);
        assert!(calendars[0].is_default);
        assert_eq!(meeting.calendar_id, calendars[0].id);
        assert_eq!(meeting.start_at.as_deref(), Some("2026-11-18T08:00:00Z"));
        assert_eq!(meeting.start_local.as_deref(), Some("2026-11-18T09:00"));
        assert_eq!(trip.start_at, None);
        assert_eq!(block.start_at, "2026-11-18T13:00:00Z");
        assert_eq!(
            (
                count(&pool, "events").await,
                count(&pool, "work_blocks").await
            ),
            (2, 1)
        );

        let items = list_items(
            &pool,
            DEFAULT_WORKSPACE,
            range("2026-11-18", "2026-11-19", "Europe/Paris"),
        )
        .await
        .unwrap()
        .items;
        let kinds: Vec<_> = items
            .iter()
            .map(|item| (item.kind, item.title.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                (ItemKind::Event, "Trip"),
                (ItemKind::Deadline, "Sample issue"),
                (ItemKind::Event, "Standup"),
                (ItemKind::WorkBlock, "Sample issue"),
            ]
        );
        assert_eq!(items[0].color.as_deref(), Some("blue"));
        assert_eq!(items[3].issue_number, Some(1));
        assert_eq!(items[3].start.as_deref(), Some("2026-11-18T14:00"));

        // Deleting the issue deletes its blocks but no events.
        sqlx::query("DELETE FROM issues WHERE id = ?")
            .bind(&issue)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            (
                count(&pool, "events").await,
                count(&pool, "work_blocks").await
            ),
            (2, 0)
        );
        delete_work_block(&pool, DEFAULT_WORKSPACE, &block.id)
            .await
            .expect_err("already deleted");
    });
}

#[test]
fn commands_reject_references_to_another_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let foreign_calendar = calendars_of(&pool, OTHER_WORKSPACE).await.unwrap()[0]
            .id
            .clone();
        let foreign_issue = add_issue(&pool, OTHER_WORKSPACE, None).await;
        let event = EventInput {
            calendar_id: Some(foreign_calendar.clone()),
            ..all_day("Leak", "2026-11-18", "2026-11-19")
        };
        assert_eq!(
            create_event(&pool, DEFAULT_WORKSPACE, event).await,
            Err(SchedulingError::CalendarNotFound)
        );
        let block = WorkBlockInput {
            issue_id: foreign_issue.clone(),
            time_zone: "UTC".into(),
            start: "2026-11-18T09:00".into(),
            end: "2026-11-18T10:00".into(),
        };
        assert_eq!(
            create_work_block(&pool, DEFAULT_WORKSPACE, block).await,
            Err(SchedulingError::IssueNotFound)
        );
        let own = create_event(
            &pool,
            OTHER_WORKSPACE,
            all_day("Theirs", "2026-11-18", "2026-11-19"),
        )
        .await
        .unwrap();
        assert_eq!(
            get_event(&pool, DEFAULT_WORKSPACE, &own.id).await,
            Err(SchedulingError::NotFound)
        );
        let mine = list_items(
            &pool,
            DEFAULT_WORKSPACE,
            range("2026-11-01", "2026-12-01", "UTC"),
        )
        .await
        .unwrap();
        assert!(mine.items.is_empty());

        // The database refuses cross-workspace rows written around Rust.
        let direct = sqlx::query(
            "INSERT INTO events (id, workspace_id, calendar_id, title, all_day, start_date, end_date)
             VALUES ('x', ?, ?, 'Leak', 1, '2026-11-18', '2026-11-19')",
        )
        .bind(DEFAULT_WORKSPACE)
        .bind(&foreign_calendar)
        .execute(&pool)
        .await;
        assert!(direct
            .unwrap_err()
            .to_string()
            .contains("another workspace"));
        let moved = sqlx::query("UPDATE events SET workspace_id = ? WHERE id = ?")
            .bind(DEFAULT_WORKSPACE)
            .bind(&own.id)
            .execute(&pool)
            .await;
        assert!(moved.is_err());
    });
}

#[test]
fn storage_rejects_mixed_or_inverted_timing() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let calendar = calendars_of(&pool, DEFAULT_WORKSPACE).await.unwrap()[0]
            .id
            .clone();
        for (all_day, dates, times) in [
            // All-day with times, timed without instants, and an inverted range.
            (
                1,
                ("'2026-11-18'", "'2026-11-19'"),
                ("'UTC'", "'2026-11-18T09:00'", "'2026-11-18T10:00'"),
            ),
            (0, ("NULL", "NULL"), ("'UTC'", "NULL", "NULL")),
            (
                1,
                ("'2026-11-19'", "'2026-11-18'"),
                ("NULL", "NULL", "NULL"),
            ),
        ] {
            let sql = format!(
                "INSERT INTO events (id, workspace_id, calendar_id, title, all_day, start_date, end_date,
                     time_zone, start_local, end_local, start_at, end_at)
                 VALUES (?, ?, ?, 'Bad', {all_day}, {}, {}, {}, {}, {}, NULL, NULL)",
                dates.0, dates.1, times.0, times.1, times.2
            );
            let result = sqlx::query(&sql)
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(DEFAULT_WORKSPACE)
                .bind(&calendar)
                .execute(&pool)
                .await;
            assert!(result.is_err(), "{sql}");
        }
        // A second default for the workspace is refused.
        let second = sqlx::query(
            "INSERT INTO calendars (id, workspace_id, name, color, is_default) VALUES ('d2', ?, 'Two', 'red', 1)",
        )
        .bind(DEFAULT_WORKSPACE)
        .execute(&pool)
        .await;
        assert!(second.is_err());
    });
}

#[test]
fn rejects_invalid_input_with_specific_errors() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let cases = [
            (
                timed("A", "Mars/Olympus", "2026-11-18T09:00", "2026-11-18T10:00"),
                SchedulingError::InvalidTimeZone,
            ),
            (
                timed("A", "UTC", "2026-11-18T24:00", "2026-11-19T01:00"),
                SchedulingError::InvalidTime,
            ),
            (
                timed("A", "UTC", "2026-11-18 09:00", "2026-11-18T10:00"),
                SchedulingError::InvalidTime,
            ),
            (
                timed("A", "UTC", "2026-11-18T10:00", "2026-11-18T10:00"),
                SchedulingError::InvalidRange,
            ),
            (
                timed("A", "UTC", "2026-11-18T10:00", "2027-12-18T10:00"),
                SchedulingError::InvalidRange,
            ),
            (
                all_day("A", "2026-02-30", "2026-03-01"),
                SchedulingError::InvalidDate,
            ),
            (
                all_day("A", "2026-11-18", "2026-11-18"),
                SchedulingError::InvalidRange,
            ),
            (
                timed("  ", "UTC", "2026-11-18T09:00", "2026-11-18T10:00"),
                SchedulingError::InvalidTitle,
            ),
            (
                EventInput {
                    start: Some("2026-11-18T09:00".into()),
                    ..all_day("A", "2026-11-18", "2026-11-19")
                },
                SchedulingError::InvalidTime,
            ),
        ];
        for (input, error) in cases {
            assert_eq!(
                create_event(&pool, DEFAULT_WORKSPACE, input.clone()).await,
                Err(error),
                "{input:?}"
            );
        }
        assert_eq!(
            list_items(
                &pool,
                DEFAULT_WORKSPACE,
                range("2026-11-18", "2026-11-18", "UTC")
            )
            .await,
            Err(SchedulingError::RangeTooLong)
        );
        assert_eq!(
            list_items(
                &pool,
                DEFAULT_WORKSPACE,
                range("2026-01-01", "2027-03-01", "UTC")
            )
            .await,
            Err(SchedulingError::RangeTooLong)
        );
        assert_eq!(count(&pool, "events").await, 0);
    });
}

#[test]
fn resolves_daylight_saving_gaps_and_folds_deterministically() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let zone = "America/New_York";
        // 02:30 does not exist on 8 March 2026: it moves forward to 03:30 EDT.
        let gap = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed("Gap", zone, "2026-03-08T02:30", "2026-03-08T04:00"),
        )
        .await
        .unwrap();
        assert_eq!(gap.start_at.as_deref(), Some("2026-03-08T07:30:00Z"));
        assert_eq!(
            gap.start_local.as_deref(),
            Some("2026-03-08T02:30"),
            "intent is kept"
        );
        // 01:30 happens twice on 1 November 2026: the earlier one (EDT) is used.
        let fold = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed("Fold", zone, "2026-11-01T01:30", "2026-11-01T03:00"),
        )
        .await
        .unwrap();
        assert_eq!(fold.start_at.as_deref(), Some("2026-11-01T05:30:00Z"));
        assert_eq!(
            fold.end_at.as_deref(),
            Some("2026-11-01T08:00:00Z"),
            "2.5 hours long"
        );

        // Day windows follow the zone's real day length: 23 and 25 hours.
        let short = window(&range("2026-03-08", "2026-03-09", zone)).unwrap();
        assert_eq!(
            (short.start_at.as_str(), short.end_at.as_str()),
            ("2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z")
        );
        let long = window(&range("2026-11-01", "2026-11-02", zone)).unwrap();
        assert_eq!(
            (long.start_at.as_str(), long.end_at.as_str()),
            ("2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z")
        );

        // Midnight that does not exist (Santiago, 6 September 2026) starts the day at 01:00.
        let santiago = window(&range("2026-09-06", "2026-09-07", "America/Santiago")).unwrap();
        assert_eq!(santiago.start_at, "2026-09-06T04:00:00Z");
    });
}

#[test]
fn shows_timed_items_in_the_viewers_zone_with_half_open_ranges() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        // 09:00 in Tokyo is midnight UTC and 01:00 in Paris.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed("Call", "Asia/Tokyo", "2026-11-18T09:00", "2026-11-18T10:00"),
        )
        .await
        .unwrap();
        let paris = list_items(
            &pool,
            DEFAULT_WORKSPACE,
            range("2026-11-18", "2026-11-19", "Europe/Paris"),
        )
        .await
        .unwrap()
        .items;
        assert_eq!(
            (
                paris[0].start.as_deref(),
                paris[0].end.as_deref(),
                paris[0].time_zone.as_deref()
            ),
            (
                Some("2026-11-18T01:00"),
                Some("2026-11-18T02:00"),
                Some("Asia/Tokyo")
            )
        );
        // In New York the call is on the previous evening.
        let new_york = list_items(
            &pool,
            DEFAULT_WORKSPACE,
            range("2026-11-17", "2026-11-18", "America/New_York"),
        )
        .await
        .unwrap()
        .items;
        assert_eq!(new_york[0].start.as_deref(), Some("2026-11-17T19:00"));

        // An event ending exactly at midnight is not on the next day.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed("Late", "UTC", "2026-11-20T23:00", "2026-11-21T00:00"),
        )
        .await
        .unwrap();
        let next = list_items(
            &pool,
            DEFAULT_WORKSPACE,
            range("2026-11-21", "2026-11-22", "UTC"),
        )
        .await
        .unwrap()
        .items;
        assert!(next.is_empty());
        // A multi-day all-day event appears on each of its days and not after.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            all_day("Leave", "2026-12-01", "2026-12-03"),
        )
        .await
        .unwrap();
        for (day, next, expected) in [
            ("2026-12-02", "2026-12-03", 1),
            ("2026-12-03", "2026-12-04", 0),
        ] {
            let items = list_items(&pool, DEFAULT_WORKSPACE, range(day, next, "UTC"))
                .await
                .unwrap()
                .items;
            assert_eq!(items.len(), expected, "{day}");
        }
    });
}

#[test]
fn range_reads_use_the_workspace_indexes() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for (sql, index) in [
            (
                "SELECT id FROM events WHERE workspace_id = 'w' AND all_day = 0 AND start_at < 'b' AND end_at > 'a'",
                "events_timed_range",
            ),
            (
                "SELECT id FROM events WHERE workspace_id = 'w' AND all_day = 1 AND start_date < 'b' AND end_date > 'a'",
                "events_dated_range",
            ),
            (
                "SELECT id FROM work_blocks WHERE workspace_id = 'w' AND start_at < 'b' AND end_at > 'a'",
                "work_blocks_range",
            ),
        ] {
            let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .fetch_all(&pool)
                .await
                .unwrap();
            assert!(
                plan.iter().any(|row| row.3.contains(index)),
                "{sql} does not use {index}: {plan:?}"
            );
        }
    });
}

#[test]
fn hidden_and_archived_calendars_keep_their_events_out_of_views() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let event = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            all_day("Quiet", "2026-11-18", "2026-11-19"),
        )
        .await
        .unwrap();
        let visible = || async {
            list_items(
                &pool,
                DEFAULT_WORKSPACE,
                range("2026-11-18", "2026-11-19", "UTC"),
            )
            .await
            .unwrap()
            .items
            .len()
        };
        assert_eq!(visible().await, 1);
        sqlx::query("UPDATE calendars SET hidden = 1")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(visible().await, 0);
        // Still stored.
        assert_eq!(
            get_event(&pool, DEFAULT_WORKSPACE, &event.id)
                .await
                .unwrap()
                .title,
            "Quiet"
        );
    });
}

mod temporal {
    //! U2-P3-05: zones, local dates, daylight saving, and boundaries.
    use super::*;
    use crate::test_support::TempDatabase;

    async fn titles(pool: &SqlitePool, from: &str, to: &str, zone: &str) -> Vec<String> {
        list_items(pool, DEFAULT_WORKSPACE, range(from, to, zone))
            .await
            .unwrap()
            .items
            .into_iter()
            .map(|item| item.title)
            .collect()
    }

    #[test]
    fn timed_events_show_in_each_viewer_zone_after_a_restart() {
        tauri::async_runtime::block_on(async {
            let database = TempDatabase::new("zones-restart");
            let pool = database.open().await;
            migrator(i64::MAX).await.run(&pool).await.unwrap();
            create_event(
                &pool,
                DEFAULT_WORKSPACE,
                timed("Sync", "Asia/Tokyo", "2026-11-18T09:00", "2026-11-18T10:00"),
            )
            .await
            .unwrap();
            pool.close().await;

            let pool = database.open().await;
            for (zone, from, start) in [
                ("Asia/Tokyo", "2026-11-18", "2026-11-18T09:00"),
                ("Europe/London", "2026-11-18", "2026-11-18T00:00"),
                ("America/Los_Angeles", "2026-11-17", "2026-11-17T16:00"),
                ("Asia/Kolkata", "2026-11-18", "2026-11-18T05:30"),
            ] {
                let to = time::add_days(time::date(from).unwrap(), 1)
                    .unwrap()
                    .to_string();
                let items = list_items(&pool, DEFAULT_WORKSPACE, range(from, &to, zone))
                    .await
                    .unwrap()
                    .items;
                assert_eq!(items.len(), 1, "{zone}");
                assert_eq!(items[0].start.as_deref(), Some(start), "{zone}");
                assert_eq!(items[0].time_zone.as_deref(), Some("Asia/Tokyo"));
            }
            pool.close().await;
        });
    }

    #[test]
    fn leap_days_and_month_and_year_boundaries() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            create_event(
                &pool,
                DEFAULT_WORKSPACE,
                all_day("Leap", "2028-02-29", "2028-03-01"),
            )
            .await
            .unwrap();
            assert_eq!(
                titles(&pool, "2028-02-29", "2028-03-01", "UTC").await,
                ["Leap"]
            );
            assert!(titles(&pool, "2028-03-01", "2028-03-02", "UTC")
                .await
                .is_empty());
            assert!(titles(&pool, "2028-02-28", "2028-02-29", "UTC")
                .await
                .is_empty());
            // 29 February exists only in leap years.
            assert_eq!(
                create_event(
                    &pool,
                    DEFAULT_WORKSPACE,
                    all_day("No", "2027-02-29", "2027-03-01")
                )
                .await,
                Err(SchedulingError::InvalidDate)
            );

            // Across New Year in UTC, on both days. In Tokyo it is New Year's Day only.
            create_event(
                &pool,
                DEFAULT_WORKSPACE,
                timed("Midnight", "UTC", "2026-12-31T23:30", "2027-01-01T00:30"),
            )
            .await
            .unwrap();
            assert_eq!(
                titles(&pool, "2026-12-31", "2027-01-01", "UTC").await,
                ["Midnight"]
            );
            assert_eq!(
                titles(&pool, "2027-01-01", "2027-01-02", "UTC").await,
                ["Midnight"]
            );
            assert!(titles(&pool, "2026-12-31", "2027-01-01", "Asia/Tokyo")
                .await
                .is_empty());
            assert_eq!(
                titles(&pool, "2027-01-01", "2027-01-02", "Asia/Tokyo").await,
                ["Midnight"]
            );

            // An all-day event across a month end, read one month at a time.
            create_event(
                &pool,
                DEFAULT_WORKSPACE,
                all_day("Move", "2026-01-30", "2026-02-03"),
            )
            .await
            .unwrap();
            assert_eq!(
                titles(&pool, "2026-01-01", "2026-02-01", "UTC").await,
                ["Move"]
            );
            assert_eq!(
                titles(&pool, "2026-02-01", "2026-03-01", "UTC").await,
                ["Move"]
            );
            assert!(titles(&pool, "2026-02-03", "2026-02-04", "UTC")
                .await
                .is_empty());
        });
    }

    #[test]
    fn overlap_endpoints_are_half_open() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            // Starts exactly at the window's end, and ends exactly at its start.
            create_event(
                &pool,
                DEFAULT_WORKSPACE,
                timed("After", "UTC", "2026-11-19T00:00", "2026-11-19T01:00"),
            )
            .await
            .unwrap();
            create_event(
                &pool,
                DEFAULT_WORKSPACE,
                timed("Before", "UTC", "2026-11-17T23:00", "2026-11-18T00:00"),
            )
            .await
            .unwrap();
            create_event(
                &pool,
                DEFAULT_WORKSPACE,
                timed("Inside", "UTC", "2026-11-18T00:00", "2026-11-18T00:01"),
            )
            .await
            .unwrap();
            assert_eq!(
                titles(&pool, "2026-11-18", "2026-11-19", "UTC").await,
                ["Inside"]
            );
        });
    }

    #[test]
    fn daylight_saving_in_both_hemispheres_and_half_hour_shifts() {
        let check = |zone: &str, local: &str, expected_utc: &str, shown: &str| {
            let tz = time::zone(zone).unwrap();
            let instant = time::resolve(time::wall_clock(local).unwrap(), &tz).unwrap();
            assert_eq!(time::instant(instant), expected_utc, "{zone} {local}");
            assert_eq!(time::local(instant, &tz), shown, "{zone} {local}");
        };
        // Sydney springs forward at 02:00 on 4 October 2026: 02:30 becomes 03:30 (+11).
        check(
            "Australia/Sydney",
            "2026-10-04T02:30",
            "2026-10-03T16:30:00Z",
            "2026-10-04T03:30",
        );
        // Sydney falls back on 5 April 2026: 02:30 happens twice; the earlier is +11.
        check(
            "Australia/Sydney",
            "2026-04-05T02:30",
            "2026-04-04T15:30:00Z",
            "2026-04-05T02:30",
        );
        // Lord Howe moves by 30 minutes: 02:15 does not exist and becomes 02:45 (+11).
        check(
            "Australia/Lord_Howe",
            "2026-10-04T02:15",
            "2026-10-03T15:45:00Z",
            "2026-10-04T02:45",
        );
        // A zone without daylight saving resolves every time unchanged.
        check(
            "Asia/Kolkata",
            "2026-03-08T02:30",
            "2026-03-07T21:00:00Z",
            "2026-03-08T02:30",
        );
    }

    #[test]
    fn a_time_zone_rules_update_re_resolves_instants_from_intent() {
        tauri::async_runtime::block_on(async {
            let pool = migrated_pool().await;
            let event = create_event(
                &pool,
                DEFAULT_WORKSPACE,
                timed(
                    "Fixed",
                    "Europe/Paris",
                    "2026-07-01T09:00",
                    "2026-07-01T10:00",
                ),
            )
            .await
            .unwrap();
            let issue = add_issue(&pool, DEFAULT_WORKSPACE, None).await;
            create_work_block(
                &pool,
                DEFAULT_WORKSPACE,
                WorkBlockInput {
                    issue_id: issue,
                    time_zone: "Europe/Paris".into(),
                    start: "2026-07-01T14:00".into(),
                    end: "2026-07-01T15:00".into(),
                },
            )
            .await
            .unwrap();
            // Pretend the instants were resolved with older rules.
            let stale = || async {
                for table in ["events", "work_blocks"] {
                    sqlx::query(&format!(
                        "UPDATE {table} SET start_at = '2026-07-01T08:30:00Z', end_at = '2026-07-01T09:30:00Z'"
                    ))
                    .execute(&pool)
                    .await
                    .unwrap();
                }
            };
            stale().await;
            sqlx::query("INSERT OR REPLACE INTO scheduling_state (workspace_id, tzdb_version) VALUES (?, '1999a')")
                .bind(DEFAULT_WORKSPACE)
                .execute(&pool)
                .await
                .unwrap();

            // The first read under the bundled rules restores them from intent.
            let items = list_items(
                &pool,
                DEFAULT_WORKSPACE,
                range("2026-07-01", "2026-07-02", "Europe/Paris"),
            )
            .await
            .unwrap()
            .items;
            let starts: Vec<_> = items
                .iter()
                .map(|item| item.start.as_deref().unwrap())
                .collect();
            assert_eq!(starts, ["2026-07-01T09:00", "2026-07-01T14:00"]);
            let stored = get_event(&pool, DEFAULT_WORKSPACE, &event.id)
                .await
                .unwrap();
            assert_eq!(stored.start_at.as_deref(), Some("2026-07-01T07:00:00Z"));
            assert_eq!(stored.updated_at, event.updated_at, "not a user edit");
            let (version,): (String,) = sqlx::query_as("SELECT tzdb_version FROM scheduling_state")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(version, tzdb_version());

            // It runs once per release: the same version does not rescan.
            stale().await;
            assert_eq!(
                refresh_instants(&pool, DEFAULT_WORKSPACE, tzdb_version())
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                refresh_instants(&pool, DEFAULT_WORKSPACE, "next")
                    .await
                    .unwrap(),
                2
            );
        });
    }
}

#[test]
fn rescheduling_closing_and_archiving_an_issue_only_moves_its_deadline() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let issue = add_issue(&pool, DEFAULT_WORKSPACE, None).await;
        crate::issues::set_due_date(&pool, DEFAULT_WORKSPACE, &issue, Some("2026-11-10"))
            .await
            .unwrap();
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            all_day("Trip", "2026-11-17", "2026-11-20"),
        )
        .await
        .unwrap();
        create_work_block(
            &pool,
            DEFAULT_WORKSPACE,
            WorkBlockInput {
                issue_id: issue.clone(),
                time_zone: "UTC".into(),
                start: "2026-11-18T14:00".into(),
                end: "2026-11-18T16:00".into(),
            },
        )
        .await
        .unwrap();
        let snapshot = || async {
            sqlx::query_as::<_, (String,)>(
                "SELECT (SELECT json_group_array(json_array(id, title, start_date, end_date, updated_at)) FROM events)
                     || (SELECT json_group_array(json_array(id, start_at, end_at, updated_at)) FROM work_blocks)",
            )
            .fetch_one(&pool)
            .await
            .unwrap()
            .0
        };
        let before = snapshot().await;
        let deadlines = || async {
            list_items(
                &pool,
                DEFAULT_WORKSPACE,
                range("2026-11-01", "2026-12-01", "UTC"),
            )
            .await
            .unwrap()
            .items
            .into_iter()
            .filter(|item| item.kind == ItemKind::Deadline)
            .collect::<Vec<_>>()
        };
        let early = deadlines().await;
        assert_eq!(early[0].start_date.as_deref(), Some("2026-11-10"));

        crate::issues::set_due_date(&pool, DEFAULT_WORKSPACE, &issue, Some("2026-11-25"))
            .await
            .unwrap();
        let moved = deadlines().await;
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].start_date.as_deref(), Some("2026-11-25"));
        assert!(!moved[0].closed);

        crate::issues::set_status(&pool, DEFAULT_WORKSPACE, &issue, "done")
            .await
            .unwrap();
        assert!(deadlines().await[0].closed);

        crate::issues::set_archived(&pool, DEFAULT_WORKSPACE, &issue, true)
            .await
            .unwrap();
        assert!(deadlines().await.is_empty());

        // No calendar row was written, copied, or changed along the way.
        assert_eq!(snapshot().await, before);
        assert_eq!(count(&pool, "events").await, 1);
    });
}
