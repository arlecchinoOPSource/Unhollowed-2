//! Schedule analytics: reconciliation with the calendar, overlap, DST, local
//! day crossings, all-day rules, changed occurrences, project attribution,
//! hidden calendars, and workspace scope. Dates and records are synthetic.

use super::schedule::{schedule, ScheduleAnalytics};
use super::AnalyticsError;
use crate::scheduling::recurrence::{cancel_occurrence, update_occurrence, RepeatRule};
use crate::scheduling::{create_event, list_items, EventInput, ItemKind, ItemRange};
use crate::test_support::{add_workspace, migrated_pool, DEFAULT_WORKSPACE, OTHER_WORKSPACE};
use sqlx::SqlitePool;

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";
const ZONE: &str = "Europe/Paris";

async fn timed(pool: &SqlitePool, workspace: &str, title: &str, start: &str, end: &str) -> String {
    create_event(
        pool,
        workspace,
        EventInput {
            title: title.into(),
            all_day: false,
            time_zone: Some(ZONE.into()),
            start: Some(start.into()),
            end: Some(end.into()),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .id
}

async fn all_day(pool: &SqlitePool, title: &str, start: &str, end: &str) -> String {
    create_event(
        pool,
        WS,
        EventInput {
            title: title.into(),
            all_day: true,
            start_date: Some(start.into()),
            end_date: Some(end.into()),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .id
}

async fn exec(pool: &SqlitePool, sql: &str, binds: &[&str]) {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query.execute(pool).await.unwrap();
}

async fn project(pool: &SqlitePool, id: &str) {
    exec(
        pool,
        "INSERT INTO projects (id, workspace_id, name) VALUES (?, ?, ?)",
        &[id, WS, id],
    )
    .await;
}

async fn issue(
    pool: &SqlitePool,
    number: i64,
    project: Option<&str>,
    due: Option<&str>,
    status: &str,
) -> String {
    let id = format!("issue-{number}");
    sqlx::query(
        "INSERT INTO issues (id, workspace_id, number, project_id, title, description, status, due_date)
         VALUES (?, ?, ?, ?, 'Issue', '{}', ?, ?)",
    )
    .bind(&id)
    .bind(WS)
    .bind(number)
    .bind(project)
    .bind(status)
    .bind(due)
    .execute(pool)
    .await
    .unwrap();
    id
}

/// A work block at Paris wall-clock times. The calendar derives the stored
/// instants from them, so the placeholders here are replaced on read.
async fn block(pool: &SqlitePool, id: &str, issue: &str, start: &str, end: &str) {
    exec(
        pool,
        "INSERT INTO work_blocks (id, workspace_id, issue_id, time_zone, start_local, end_local, start_at, end_at)
         VALUES (?, ?, ?, 'Europe/Paris', ?, ?, '2000-01-01T00:00:00Z', '2000-01-01T01:00:00Z')",
        &[id, WS, issue, start, end],
    )
    .await;
}

async fn run(pool: &SqlitePool, from: &str, to: &str, project: Option<&str>) -> ScheduleAnalytics {
    schedule(pool, WS, from, to, project, ZONE, TODAY)
        .await
        .unwrap()
}

fn day<'a>(a: &'a ScheduleAnalytics, date: &str) -> &'a super::schedule::Load {
    &a.days.iter().find(|d| d.start == date).unwrap().load
}

#[test]
fn overlapping_events_and_work_sessions_count_once_as_busy_time() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        timed(&pool, WS, "First", "2026-11-10T09:00", "2026-11-10T10:00").await;
        timed(&pool, WS, "Second", "2026-11-10T09:30", "2026-11-10T10:30").await;
        let work = issue(&pool, 1, None, None, "todo").await;
        // 10:00 to 11:00 in Paris (UTC+1).
        block(&pool, "w1", &work, "2026-11-10T10:00", "2026-11-10T11:00").await;
        let a = run(&pool, "2026-11-01", "2026-11-30", None).await;
        let d = day(&a, "2026-11-10");
        assert_eq!((d.event_minutes, d.work_block_minutes), (120, 60));
        // 09:00 to 11:00 is covered; the 60 minutes beyond that are overlap.
        assert_eq!((d.busy_minutes, d.overlap_minutes), (120, 60));
        assert_eq!((d.timed_events, d.work_blocks), (2, 1));
        assert_eq!(a.totals.busy_minutes, 120);
        assert_eq!(a.days.len(), 30);
        assert_eq!(day(&a, "2026-11-11").busy_minutes, 0);
    });
}

#[test]
fn summaries_reconcile_with_the_calendar_items_for_the_period() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        timed(&pool, WS, "One", "2026-11-04T09:00", "2026-11-04T10:30").await;
        all_day(&pool, "Trip", "2026-11-06", "2026-11-09").await;
        create_event(
            &pool,
            WS,
            EventInput {
                title: "Daily".into(),
                all_day: false,
                time_zone: Some(ZONE.into()),
                start: Some("2026-11-02T08:00".into()),
                end: Some("2026-11-02T08:30".into()),
                repeat: Some(RepeatRule {
                    freq: "daily".into(),
                    interval: 1,
                    count: None,
                    until: None,
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let work = issue(&pool, 1, None, Some("2026-11-12"), "todo").await;
        issue(&pool, 2, None, Some("2026-11-13"), "done").await;
        block(&pool, "w1", &work, "2026-11-05T15:00", "2026-11-05T16:30").await;

        let a = run(&pool, "2026-11-01", "2026-11-30", None).await;
        let source = list_items(
            &pool,
            WS,
            ItemRange {
                from: "2026-11-01".into(),
                to: "2026-12-01".into(),
                time_zone: ZONE.into(),
            },
        )
        .await
        .unwrap();
        let count = |kind: ItemKind, closed: bool| {
            source
                .items
                .iter()
                .filter(|i| i.kind == kind && i.closed == closed)
                .count() as i64
        };
        // The calendar lists 29 daily occurrences, one timed event, one all-day trip.
        assert_eq!(a.totals.events, count(ItemKind::Event, false));
        assert_eq!(a.totals.events, 31);
        assert_eq!((a.totals.timed_events, a.totals.all_day_events), (30, 1));
        assert_eq!(a.totals.work_blocks, count(ItemKind::WorkBlock, false));
        // The done issue's due date is not an open deadline.
        assert_eq!(a.totals.deadlines, 1);
        assert_eq!(a.totals.event_minutes, 29 * 30 + 90);
        assert_eq!(a.totals.work_block_minutes, 90);
        // The days add up to the totals.
        assert_eq!(
            a.days.iter().map(|d| d.load.event_minutes).sum::<i64>(),
            a.totals.event_minutes
        );
        assert_eq!(
            a.weeks.iter().map(|w| w.load.event_minutes).sum::<i64>(),
            a.totals.event_minutes
        );
        assert_eq!(a.weeks.first().unwrap().start, "2026-11-01");
        assert_eq!(a.weeks[1].start, "2026-11-02");
        assert!(!a.truncated);
    });
}

#[test]
fn dst_days_use_real_elapsed_time_and_midnight_crossings_split_by_local_day() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        // Paris: 2 AM does not exist on 2026-03-29, and 2026-10-25 has two 2 AMs.
        timed(&pool, WS, "Spring", "2026-03-29T00:30", "2026-03-29T04:30").await;
        timed(&pool, WS, "Autumn", "2026-10-25T00:30", "2026-10-25T04:30").await;
        let spring = run(&pool, "2026-03-29", "2026-03-29", None).await;
        assert_eq!(spring.totals.event_minutes, 180);
        let autumn = run(&pool, "2026-10-25", "2026-10-25", None).await;
        assert_eq!(autumn.totals.event_minutes, 300);

        // 23:00 to 01:00 is one event, split 60 and 60 by local day.
        timed(&pool, WS, "Late", "2026-11-10T23:00", "2026-11-11T01:00").await;
        let both = run(&pool, "2026-11-10", "2026-11-11", None).await;
        assert_eq!(both.totals.timed_events, 1);
        assert_eq!(
            (
                day(&both, "2026-11-10").event_minutes,
                day(&both, "2026-11-11").event_minutes
            ),
            (60, 60)
        );
        // A period that only holds its second half counts that half, once.
        let second = run(&pool, "2026-11-11", "2026-11-11", None).await;
        assert_eq!(
            (second.totals.timed_events, second.totals.event_minutes),
            (1, 60)
        );
        // The same wall-clock event reads differently in another zone.
        let utc = schedule(&pool, WS, "2026-11-10", "2026-11-10", None, "UTC", TODAY)
            .await
            .unwrap();
        assert_eq!(utc.totals.event_minutes, 120);
    });
}

#[test]
fn all_day_events_cover_days_without_adding_minutes() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        // End is exclusive: the 10th, 11th, and 12th.
        all_day(&pool, "Conference", "2026-11-10", "2026-11-13").await;
        let a = run(&pool, "2026-11-01", "2026-11-30", None).await;
        assert_eq!(
            (
                a.totals.events,
                a.totals.all_day_events,
                a.totals.event_minutes
            ),
            (1, 1, 0)
        );
        for date in ["2026-11-10", "2026-11-11", "2026-11-12"] {
            assert_eq!(day(&a, date).all_day_events, 1, "{date}");
        }
        assert_eq!(day(&a, "2026-11-13").all_day_events, 0);
        assert_eq!(day(&a, "2026-11-11").busy_minutes, 0);
        // A period that only holds its last day still sees it.
        assert_eq!(
            run(&pool, "2026-11-12", "2026-11-12", None)
                .await
                .totals
                .all_day_events,
            1
        );
    });
}

#[test]
fn canceled_and_moved_occurrences_follow_the_calendar() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let series = create_event(
            &pool,
            WS,
            EventInput {
                title: "Standup".into(),
                all_day: false,
                time_zone: Some(ZONE.into()),
                start: Some("2026-11-02T09:00".into()),
                end: Some("2026-11-02T10:00".into()),
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
        let before = run(&pool, "2026-11-01", "2026-11-30", None).await;
        assert_eq!(
            (before.totals.timed_events, before.totals.event_minutes),
            (5, 300)
        );

        let items = list_items(
            &pool,
            WS,
            ItemRange {
                from: "2026-11-01".into(),
                to: "2026-12-01".into(),
                time_zone: ZONE.into(),
            },
        )
        .await
        .unwrap()
        .items;
        let key = |date: &str| {
            items
                .iter()
                .find(|i| {
                    i.local_start
                        .as_deref()
                        .is_some_and(|s| s.starts_with(date))
                })
                .and_then(|i| i.occurrence.clone())
                .unwrap()
        };
        cancel_occurrence(&pool, WS, &series, &key("2026-11-03"))
            .await
            .unwrap();
        update_occurrence(
            &pool,
            WS,
            &series,
            &key("2026-11-04"),
            EventInput {
                title: "Standup".into(),
                all_day: false,
                time_zone: Some(ZONE.into()),
                start: Some("2026-11-04T14:00".into()),
                end: Some("2026-11-04T14:45".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let after = run(&pool, "2026-11-01", "2026-11-30", None).await;
        // One occurrence is gone, one is 45 minutes at 14:00 instead of 60 at 09:00.
        assert_eq!(
            (after.totals.timed_events, after.totals.event_minutes),
            (4, 3 * 60 + 45)
        );
        assert_eq!(day(&after, "2026-11-03").timed_events, 0);
        assert_eq!(day(&after, "2026-11-04").event_minutes, 45);
    });
}

#[test]
fn project_attribution_distinguishes_assigned_shared_and_unassigned_time() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        project(&pool, "p1").await;
        project(&pool, "p2").await;
        let mine = timed(
            &pool,
            WS,
            "Planning",
            "2026-11-10T09:00",
            "2026-11-10T10:30",
        )
        .await;
        let both = timed(&pool, WS, "Sync", "2026-11-11T09:00", "2026-11-11T10:00").await;
        timed(&pool, WS, "Lunch", "2026-11-12T12:00", "2026-11-12T12:45").await;
        for (event, linked) in [(&mine, "p1"), (&both, "p1"), (&both, "p2")] {
            exec(
                &pool,
                "INSERT INTO event_projects (event_id, project_id, workspace_id) VALUES (?, ?, ?)",
                &[event, linked, WS],
            )
            .await;
        }
        let in_p1 = issue(&pool, 1, Some("p1"), Some("2026-11-20"), "todo").await;
        let none = issue(&pool, 2, None, None, "todo").await;
        issue(&pool, 3, Some("p2"), Some("2026-11-21"), "todo").await;
        block(&pool, "w1", &in_p1, "2026-11-13T10:00", "2026-11-13T11:00").await;
        block(&pool, "w2", &none, "2026-11-13T12:00", "2026-11-13T12:30").await;

        let a = run(&pool, "2026-11-01", "2026-11-30", None).await;
        let line = |kind: &str, id: Option<&str>| {
            a.projects
                .iter()
                .find(|p| p.kind == kind && p.project_id.as_deref() == id)
                .unwrap_or_else(|| panic!("{kind} {id:?}"))
        };
        let p1 = line("project", Some("p1"));
        assert_eq!(
            (
                p1.events,
                p1.event_minutes,
                p1.work_blocks,
                p1.work_block_minutes,
                p1.deadlines
            ),
            (1, 90, 1, 60, 1)
        );
        let p2 = line("project", Some("p2"));
        assert_eq!((p2.events, p2.work_blocks, p2.deadlines), (0, 0, 1));
        // Linked to two projects: counted once, as shared, not twice.
        let shared = line("shared", None);
        assert_eq!((shared.events, shared.event_minutes), (1, 60));
        let none = line("unassigned", None);
        assert_eq!(
            (
                none.events,
                none.event_minutes,
                none.work_blocks,
                none.work_block_minutes
            ),
            (1, 45, 1, 30)
        );
        // No time is counted twice across the lines.
        let by_line: i64 = a
            .projects
            .iter()
            .map(|p| p.event_minutes + p.work_block_minutes)
            .sum();
        assert_eq!(
            by_line,
            a.totals.event_minutes + a.totals.work_block_minutes
        );

        // Filtering keeps what belongs to the project, shared events included.
        let f = run(&pool, "2026-11-01", "2026-11-30", Some("p1")).await;
        assert_eq!(
            (f.totals.events, f.totals.work_blocks, f.totals.deadlines),
            (2, 1, 1)
        );
        assert_eq!(f.totals.event_minutes, 150);
        assert_eq!(f.projects.len(), 1);
        assert_eq!(f.projects[0].project_id.as_deref(), Some("p1"));
    });
}

#[test]
fn hidden_calendars_other_workspaces_and_bad_input_are_handled() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        timed(&pool, WS, "Mine", "2026-11-10T09:00", "2026-11-10T10:00").await;
        timed(
            &pool,
            OTHER_WORKSPACE,
            "Theirs",
            "2026-11-10T09:00",
            "2026-11-10T11:00",
        )
        .await;
        assert_eq!(
            run(&pool, "2026-11-01", "2026-11-30", None)
                .await
                .totals
                .event_minutes,
            60
        );
        let theirs = schedule(
            &pool,
            OTHER_WORKSPACE,
            "2026-11-01",
            "2026-11-30",
            None,
            ZONE,
            TODAY,
        )
        .await
        .unwrap();
        assert_eq!(theirs.totals.event_minutes, 120);
        // Events in a hidden calendar are not scheduled time: the calendar hides them.
        exec(
            &pool,
            "UPDATE calendars SET hidden = 1 WHERE workspace_id = ?",
            &[WS],
        )
        .await;
        let hidden = run(&pool, "2026-11-01", "2026-11-30", None).await;
        assert_eq!((hidden.totals.events, hidden.totals.event_minutes), (0, 0));

        for (from, to, zone, project, error) in [
            (
                "2026-11-30",
                "2026-11-01",
                ZONE,
                None,
                AnalyticsError::InvalidRange,
            ),
            (
                "2026-01-01",
                "2027-01-02",
                ZONE,
                None,
                AnalyticsError::InvalidRange,
            ),
            (
                "2026-02-30",
                "2026-03-01",
                ZONE,
                None,
                AnalyticsError::InvalidDate,
            ),
            (
                "2026-11-01",
                "2026-11-30",
                "Mars/Base",
                None,
                AnalyticsError::InvalidTimeZone,
            ),
            (
                "2026-11-01",
                "2026-11-30",
                ZONE,
                Some("nope"),
                AnalyticsError::NotFound,
            ),
        ] {
            assert_eq!(
                schedule(&pool, WS, from, to, project, zone, TODAY).await,
                Err(error)
            );
        }
    });
}

#[test]
fn upcoming_looks_ahead_from_today_whatever_the_period() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        timed(
            &pool,
            WS,
            "Tomorrow",
            "2026-11-18T09:00",
            "2026-11-18T10:00",
        )
        .await;
        timed(
            &pool,
            WS,
            "Next week",
            "2026-11-24T09:00",
            "2026-11-24T10:00",
        )
        .await;
        all_day(&pool, "Holiday", "2026-11-20", "2026-11-21").await;
        let work = issue(&pool, 1, None, Some("2026-11-19"), "todo").await;
        block(&pool, "w1", &work, "2026-11-18T15:00", "2026-11-18T16:00").await;
        // A period far in the past does not change what is coming up.
        let a = run(&pool, "2026-01-01", "2026-01-31", None).await;
        assert_eq!((a.totals.events, a.totals.work_blocks), (0, 0));
        let up = &a.upcoming;
        // Today through the next 6 days: Nov 17 to Nov 23.
        assert_eq!((up.events, up.work_blocks, up.deadlines), (2, 1, 1));
        let next: Vec<_> = up
            .next
            .iter()
            .map(|n| (n.kind.as_str(), n.title.as_str(), n.when.as_str()))
            .collect();
        assert_eq!(
            next,
            [
                ("event", "Tomorrow", "2026-11-18T09:00"),
                ("work_block", "Issue", "2026-11-18T15:00"),
                ("deadline", "Issue", "2026-11-19"),
                ("event", "Holiday", "2026-11-20"),
            ]
        );
    });
}
