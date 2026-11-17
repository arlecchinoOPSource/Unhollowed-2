//! Workspace analytics: every documented formula against known records, local
//! day boundaries, the project filter, availability, errors, workspace scope,
//! and a representative size. Dates and records are synthetic.

use super::progress::progress;
use super::*;
use crate::checkins::save as save_checkin;
use crate::habits::{create as create_habit, set_completion};
use crate::scheduling::recurrence::RepeatRule;
use crate::scheduling::{create_event, EventInput};
use crate::test_support::{
    add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";
const ZONE: &str = "Europe/Paris";

async fn exec(pool: &SqlitePool, sql: &str, binds: &[&str]) {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query.execute(pool).await.unwrap();
}

async fn project(pool: &SqlitePool, id: &str, status: &str, target: &str) {
    exec(
        pool,
        "INSERT INTO projects (id, workspace_id, name, status, target_date) VALUES (?, ?, ?, ?, ?)",
        &[id, WS, id, status, target],
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn issue(
    pool: &SqlitePool,
    number: i64,
    project: Option<&str>,
    status: &str,
    created: &str,
    completed: Option<&str>,
    due: Option<&str>,
    archived: bool,
) -> String {
    let id = format!("issue-{number}");
    sqlx::query(
        "INSERT INTO issues (id, workspace_id, number, project_id, title, description, status,
                             due_date, completed_at, created_at, archived_at)
         VALUES (?, ?, ?, ?, 'Issue', '{}', ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(WS)
    .bind(number)
    .bind(project)
    .bind(status)
    .bind(due)
    .bind(completed)
    .bind(created)
    .bind(archived.then_some("2026-11-01T00:00:00Z"))
    .execute(pool)
    .await
    .unwrap();
    id
}

/// Two projects' worth of records with known answers; see docs/ANALYTICS.md.
async fn seed(pool: &SqlitePool) {
    project(pool, "p1", "active", "2026-11-20").await;
    project(pool, "p2", "completed", "2026-11-10").await;
    project(pool, "p3", "archived", "2026-11-15").await;
    project(pool, "p4", "planned", "2026-11-05").await;
    // Paris is UTC+1 in November, so 23:30Z is half past midnight the next day.
    issue(
        pool,
        1,
        Some("p1"),
        "todo",
        "2026-11-05T10:00:00.000Z",
        None,
        Some("2026-11-12"),
        false,
    )
    .await;
    issue(
        pool,
        2,
        Some("p1"),
        "done",
        "2026-10-31T23:30:00.000Z",
        Some("2026-11-10T09:00:00.000Z"),
        Some("2026-11-10"),
        false,
    )
    .await;
    issue(
        pool,
        3,
        Some("p2"),
        "done",
        "2026-10-01T00:00:00.000Z",
        Some("2026-11-30T23:30:00.000Z"),
        Some("2026-11-30"),
        false,
    )
    .await;
    issue(
        pool,
        4,
        None,
        "canceled",
        "2026-11-02T08:00:00.000Z",
        None,
        Some("2026-11-15"),
        false,
    )
    .await;
    issue(
        pool,
        5,
        Some("p1"),
        "in_progress",
        "2026-11-17T08:00:00.000Z",
        None,
        Some("2026-12-05"),
        false,
    )
    .await;
    issue(
        pool,
        6,
        Some("p1"),
        "todo",
        "2026-11-03T08:00:00.000Z",
        None,
        Some("2026-11-03"),
        true,
    )
    .await;

    // A canceled issue linked to an objective is left out of its progress.
    issue(
        pool,
        7,
        Some("p1"),
        "canceled",
        "2026-10-02T08:00:00.000Z",
        None,
        None,
        false,
    )
    .await;
    exec(
        pool,
        "INSERT INTO objectives (id, project_id, title, description) VALUES ('o1', 'p1', 'O1', '')",
        &[],
    )
    .await;
    exec(
        pool,
        "INSERT INTO objectives (id, project_id, title, description) VALUES ('o2', 'p2', 'O2', '')",
        &[],
    )
    .await;
    for (objective, issue) in [
        ("o1", "issue-1"),
        ("o1", "issue-2"),
        ("o1", "issue-7"),
        ("o2", "issue-3"),
    ] {
        exec(
            pool,
            "INSERT INTO objective_issues (objective_id, issue_id) VALUES (?, ?)",
            &[objective, issue],
        )
        .await;
    }
    for (id, project, state, due, closed) in [
        ("m1", Some("p1"), "open", "2026-11-12", None),
        (
            "m2",
            Some("p1"),
            "closed",
            "2026-11-08",
            Some("2026-11-08T10:00:00Z"),
        ),
        ("m3", None, "open", "2026-12-01", None),
        ("m4", Some("p2"), "open", "2026-11-25", None),
    ] {
        sqlx::query(
            "INSERT INTO milestones (id, workspace_id, project_id, title, due_date, state, closed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id).bind(WS).bind(project).bind(id).bind(due).bind(state).bind(closed)
        .execute(pool).await.unwrap();
    }

    // Calendar: a daily all-day series from Nov 2, a 90-minute timed event
    // linked to p1, and one hour of work on issue 1.
    create_event(
        pool,
        WS,
        EventInput {
            title: "Daily".into(),
            all_day: true,
            start_date: Some("2026-11-02".into()),
            end_date: Some("2026-11-03".into()),
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
    let timed = create_event(
        pool,
        WS,
        EventInput {
            title: "Review".into(),
            all_day: false,
            time_zone: Some(ZONE.into()),
            start: Some("2026-11-10T10:00".into()),
            end: Some("2026-11-10T11:30".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    exec(
        pool,
        "INSERT INTO event_projects (event_id, project_id, workspace_id) VALUES (?, 'p1', ?)",
        &[&timed.id, WS],
    )
    .await;
    exec(
        pool,
        "INSERT INTO work_blocks (id, workspace_id, issue_id, time_zone, start_local, end_local, start_at, end_at)
         VALUES ('w1', ?, 'issue-1', 'Europe/Paris', '2026-11-12T09:00', '2026-11-12T10:00',
                 '2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z')",
        &[WS],
    )
    .await;

    // Habits and a check-in.
    let walk = create_habit(pool, WS, "Walk", Some("2026-11-10"), TODAY)
        .await
        .unwrap();
    for day in ["2026-11-10", "2026-11-11", "2026-11-12"] {
        set_completion(pool, WS, &walk.id, day, true, TODAY)
            .await
            .unwrap();
    }
    save_checkin(pool, WS, "2026-11-05", Some(4), None, None, None, TODAY)
        .await
        .unwrap();
}

async fn run(pool: &SqlitePool, project: Option<&str>) -> WorkspaceAnalytics {
    workspace_analytics(pool, WS, "2026-11-01", "2026-11-30", project, ZONE, TODAY)
        .await
        .unwrap()
}

#[test]
fn formulas_match_the_known_records_for_the_whole_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        seed(&pool).await;
        let a = run(&pool, None).await;
        assert_eq!((a.period.days, a.period.today.as_str()), (30, TODAY));

        // Issues: created counts local days (issue 2 is Nov 1 in Paris); the
        // archived issue and the canceled issue's due date are left out.
        let i = a.issues.data.unwrap();
        assert_eq!((i.created, i.completed), (4, 1));
        assert_eq!((i.due, i.due_completed), (3, 2));
        assert!((i.due_percent.unwrap() - 200.0 / 3.0).abs() < 1e-9);
        assert_eq!((i.open, i.overdue), (2, 1));

        let p = a.projects.data.unwrap();
        assert_eq!(
            (p.planned, p.active, p.on_hold, p.completed, p.archived),
            (1, 1, 0, 1, 1)
        );
        assert_eq!(
            (p.target_in_period, p.target_completed, p.overdue),
            (3, 1, 1)
        );

        let o = a.objectives.data.unwrap();
        assert_eq!((o.objectives, o.linked_issues, o.linked_done), (2, 3, 2));
        assert!((o.done_percent.unwrap() - 200.0 / 3.0).abs() < 1e-9);

        let m = a.milestones.data.unwrap();
        assert_eq!(
            (m.open, m.due_in_period, m.closed_of_due, m.overdue),
            (3, 3, 1, 1)
        );

        let c = a.calendar.data.unwrap();
        assert_eq!((c.events, c.all_day_events, c.timed_events), (30, 29, 1));
        assert_eq!(
            (c.scheduled_minutes, c.work_blocks, c.work_block_minutes),
            (90, 1, 60)
        );
        assert!(!c.truncated);

        let h = a.habits.data.unwrap();
        assert_eq!((h.eligible, h.completed), (8, 3));
        assert_eq!(h.percent, Some(37.5));
        let mood = a.mood.data.unwrap();
        assert_eq!(
            (mood.days_recorded, mood.days_in_period, mood.mood.samples),
            (1, 17, 1)
        );
        assert_eq!((mood.energy.samples, mood.energy.average), (0, None));
    });
}

#[test]
fn a_project_filter_narrows_each_source_and_marks_the_rest_not_applicable() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        seed(&pool).await;
        let a = run(&pool, Some("p1")).await;
        assert_eq!(a.project_id.as_deref(), Some("p1"));
        let i = a.issues.data.unwrap();
        assert_eq!(
            (i.created, i.completed, i.due, i.due_completed),
            (3, 1, 2, 1)
        );
        assert_eq!(i.due_percent, Some(50.0));
        assert_eq!((i.open, i.overdue), (2, 1));
        let p = a.projects.data.unwrap();
        assert_eq!(
            (
                p.planned,
                p.active,
                p.completed,
                p.target_in_period,
                p.overdue
            ),
            (0, 1, 0, 1, 0)
        );
        let o = a.objectives.data.unwrap();
        assert_eq!((o.objectives, o.linked_issues, o.linked_done), (1, 2, 1));
        let m = a.milestones.data.unwrap();
        assert_eq!(
            (m.open, m.due_in_period, m.closed_of_due, m.overdue),
            (1, 2, 1, 1)
        );
        // Only the event linked to the project and the work on its issues.
        let c = a.calendar.data.unwrap();
        assert_eq!(
            (
                c.events,
                c.all_day_events,
                c.timed_events,
                c.scheduled_minutes
            ),
            (1, 0, 1, 90)
        );
        assert_eq!((c.work_blocks, c.work_block_minutes), (1, 60));
        // Habits and check-ins have no project, so they are not shown unfiltered.
        for (availability, data_is_none) in [
            (&a.habits.availability, a.habits.data.is_none()),
            (&a.mood.availability, a.mood.data.is_none()),
        ] {
            assert_eq!(*availability, Availability::NotApplicable);
            assert!(data_is_none);
        }
        assert!(a
            .habits
            .reason
            .unwrap()
            .contains("do not belong to a project"));
        // A project with nothing in it has real zeros and no rates.
        let empty = run(&pool, Some("p4")).await;
        let i = empty.issues.data.unwrap();
        assert_eq!((i.created, i.due, i.open), (0, 0, 0));
        assert_eq!(i.due_percent, None);
        assert_eq!(empty.objectives.data.unwrap().done_percent, None);
    });
}

#[test]
fn periods_are_bounded_and_local_days_decide_the_edges() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        seed(&pool).await;
        // Issue 3 completed at 23:30Z on Nov 30 is Dec 1 in Paris: out of
        // November, in a December period, and in a UTC November.
        let december = workspace_analytics(
            &pool,
            WS,
            "2026-12-01",
            "2026-12-01",
            None,
            ZONE,
            "2026-12-01",
        )
        .await
        .unwrap();
        assert_eq!(december.issues.data.unwrap().completed, 1);
        let utc = workspace_analytics(&pool, WS, "2026-11-01", "2026-11-30", None, "UTC", TODAY)
            .await
            .unwrap();
        assert_eq!(utc.issues.data.unwrap().completed, 2);
        // One day and a full leap year are valid; 367 days is not.
        assert!(
            workspace_analytics(&pool, WS, TODAY, TODAY, None, ZONE, TODAY)
                .await
                .is_ok()
        );
        assert!(
            workspace_analytics(&pool, WS, "2028-01-01", "2028-12-31", None, ZONE, TODAY)
                .await
                .is_ok()
        );
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
                "soon",
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
                workspace_analytics(&pool, WS, from, to, project, zone, TODAY).await,
                Err(error),
                "{from}..{to} {zone}"
            );
        }
    });
}

#[test]
fn another_workspace_is_invisible_and_cannot_be_filtered_on() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        seed(&pool).await;
        exec(
            &pool,
            "INSERT INTO projects (id, workspace_id, name) VALUES ('theirs', ?, 'Theirs')",
            &[OTHER_WORKSPACE],
        )
        .await;
        sqlx::query(
            "INSERT INTO issues (id, workspace_id, number, project_id, title, description, status, created_at)
             VALUES ('x', ?, 1, 'theirs', 'Theirs', '{}', 'todo', '2026-11-05T10:00:00.000Z')",
        )
        .bind(OTHER_WORKSPACE)
        .execute(&pool)
        .await
        .unwrap();

        // Their issue is not counted, and their project cannot be a filter here.
        assert_eq!(run(&pool, None).await.issues.data.unwrap().created, 4);
        assert_eq!(
            workspace_analytics(
                &pool,
                WS,
                "2026-11-01",
                "2026-11-30",
                Some("theirs"),
                ZONE,
                TODAY
            )
            .await,
            Err(AnalyticsError::NotFound)
        );
        let theirs = workspace_analytics(
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
        assert_eq!(theirs.issues.data.unwrap().created, 1);
        assert_eq!(theirs.projects.data.unwrap().planned, 1);
        let calendar = theirs.calendar.data.unwrap();
        assert_eq!((calendar.events, calendar.work_blocks), (0, 0));
        assert_eq!(theirs.habits.data.unwrap().eligible, 0);
    });
}

#[test]
fn a_few_thousand_issues_are_read_in_one_pass() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        exec(
            &pool,
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
             INSERT INTO issues (id, workspace_id, number, title, description, status, due_date, created_at)
             SELECT 'bulk-' || i, ?, i, 'Issue', '{}',
                    CASE i % 3 WHEN 0 THEN 'todo' WHEN 1 THEN 'done' ELSE 'in_progress' END,
                    '2026-11-' || printf('%02d', 1 + i % 28),
                    '2026-11-' || printf('%02d', 1 + i % 28) || 'T12:00:00.000Z'
             FROM n",
            &[WS],
        )
        .await;
        let started = std::time::Instant::now();
        let a = run(&pool, None).await;
        let elapsed = started.elapsed();
        let i = a.issues.data.unwrap();
        assert_eq!(i.created, 5000);
        assert_eq!(i.due, 5000);
        assert_eq!(i.open, 5000 - 1667);
        // Generous: a regression to per-row queries would be orders slower.
        assert!(elapsed < std::time::Duration::from_secs(5), "{elapsed:?}");
    });
}

#[test]
fn a_restart_recomputes_exactly_the_same_statistics() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("analytics-restart");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        seed(&pool).await;
        let before = run(&pool, None).await;
        let filtered = run(&pool, Some("p1")).await;
        pool.close().await;

        // Nothing is cached: reopening reads the same persisted records.
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(run(&pool, None).await, before);
        assert_eq!(run(&pool, Some("p1")).await, filtered);
        pool.close().await;
    });
}

async fn progress_for(
    pool: &SqlitePool,
    project: Option<&str>,
) -> super::progress::ProgressAnalytics {
    progress(pool, WS, "2026-11-01", "2026-11-30", project, ZONE, TODAY)
        .await
        .unwrap()
}

#[test]
fn progress_totals_rollups_and_deadlines_follow_the_documented_denominators() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        seed(&pool).await;
        let p = progress_for(&pool, None).await;
        // Six unarchived issues: 2 open, 2 done, 2 canceled. Canceled work is
        // neither done nor outstanding, so the rate is done / (6 - 2).
        let t = &p.totals;
        assert_eq!((t.total, t.open, t.done, t.canceled), (6, 2, 2, 2));
        assert_eq!(t.completion_percent, Some(50.0));
        assert_eq!((t.overdue, t.upcoming, t.undated_open), (1, 0, 0));

        // Archived projects are not listed; the rest are by name.
        let names: Vec<_> = p.projects.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, ["p1", "p2", "p4"]);
        let p1 = &p.projects[0];
        assert_eq!((p1.issues.total, p1.issues.done), (4, 1));
        assert!((p1.issues.completion_percent.unwrap() - 100.0 / 3.0).abs() < 1e-9);
        // Milestone completion is the milestones' own state, not issue progress.
        assert_eq!((p1.milestones_open, p1.milestones_closed), (1, 1));
        assert_eq!(
            (p1.objectives, p1.objective_linked, p1.objective_done),
            (1, 2, 1)
        );
        assert_eq!(p.projects[1].issues.completion_percent, Some(100.0));
        // A project with no issues has a defined empty answer, not 0 or 100.
        assert_eq!(
            (
                p.projects[2].issues.total,
                p.projects[2].issues.completion_percent
            ),
            (0, None)
        );

        // Open issues and milestones overdue or due in the next 14 days.
        let list: Vec<_> = p
            .deadlines
            .iter()
            .map(|d| {
                (
                    d.kind.as_str(),
                    d.title.as_str(),
                    d.due_date.as_str(),
                    d.overdue,
                )
            })
            .collect();
        assert_eq!(
            list,
            [
                ("issue", "Issue", "2026-11-12", true),
                ("milestone", "m1", "2026-11-12", true),
                ("milestone", "m4", "2026-11-25", false),
            ]
        );
        // The project filter narrows every part.
        let f = progress_for(&pool, Some("p1")).await;
        assert_eq!((f.totals.total, f.totals.done), (4, 1));
        assert_eq!(f.projects.len(), 1);
        assert_eq!(f.deadlines.len(), 2);
        assert!(f
            .deadlines
            .iter()
            .all(|d| d.project_id.as_deref() == Some("p1")));
    });
}

#[test]
fn progress_agrees_with_the_project_overview_for_the_same_project() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        seed(&pool).await;
        // Open issues across the upcoming window and undated ones too.
        issue(
            &pool,
            8,
            Some("p1"),
            "todo",
            "2026-11-04T08:00:00.000Z",
            None,
            None,
            false,
        )
        .await;
        issue(
            &pool,
            9,
            Some("p1"),
            "blocked",
            "2026-11-04T08:00:00.000Z",
            None,
            Some("2026-11-20"),
            false,
        )
        .await;
        for id in ["p1", "p2", "p4"] {
            let overview = crate::overview::overview(&pool, WS, id, TODAY)
                .await
                .unwrap();
            let ours = progress_for(&pool, Some(id))
                .await
                .projects
                .remove(0)
                .issues;
            assert_eq!(
                (ours.total, ours.open),
                (overview.total, overview.open),
                "{id}"
            );
            assert_eq!(ours.done, overview.statuses.done, "{id}");
            assert_eq!(ours.canceled, overview.statuses.canceled, "{id}");
            assert_eq!(ours.overdue, overview.overdue_count, "{id}");
            assert_eq!(ours.upcoming, overview.upcoming_count, "{id}");
            assert_eq!(ours.undated_open, overview.undated_open, "{id}");
            assert_eq!(
                ours.completion_percent,
                overview.completion.map(|c| c * 100.0),
                "{id}"
            );
        }
    });
}

#[test]
fn the_completion_trend_uses_stored_times_and_reports_what_it_cannot_place() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        // Done with a time, done without one (before times were kept), done
        // then reopened, and an archived done issue.
        issue(
            &pool,
            1,
            None,
            "done",
            "2026-10-01T00:00:00.000Z",
            Some("2026-11-10T09:00:00.000Z"),
            None,
            false,
        )
        .await;
        issue(
            &pool,
            2,
            None,
            "done",
            "2026-10-01T00:00:00.000Z",
            None,
            None,
            false,
        )
        .await;
        issue(
            &pool,
            3,
            None,
            "todo",
            "2026-10-01T00:00:00.000Z",
            None,
            None,
            false,
        )
        .await;
        issue(
            &pool,
            4,
            None,
            "done",
            "2026-10-01T00:00:00.000Z",
            Some("2026-11-10T10:00:00.000Z"),
            None,
            true,
        )
        .await;
        // 23:30Z on Nov 30 is Dec 1 in Paris, so it is in December's trend.
        issue(
            &pool,
            5,
            None,
            "done",
            "2026-10-01T00:00:00.000Z",
            Some("2026-11-30T23:30:00.000Z"),
            None,
            false,
        )
        .await;
        let t = progress_for(&pool, None).await.trend;
        assert_eq!(t.granularity, "day");
        assert_eq!(t.buckets.len(), 30);
        assert_eq!(t.buckets[9].start, "2026-11-10");
        assert_eq!(t.buckets[9].completed, 1);
        assert_eq!(t.buckets.iter().map(|b| b.completed).sum::<i64>(), 1);
        // Three unarchived done issues; one of them has no completion time.
        assert_eq!((t.done_total, t.with_time, t.without_time), (3, 2, 1));
        let december = progress(
            &pool,
            WS,
            "2026-12-01",
            "2026-12-01",
            None,
            ZONE,
            "2026-12-01",
        )
        .await
        .unwrap()
        .trend;
        assert_eq!(december.buckets[0].completed, 1);

        // A long period is shown by Monday-to-Sunday week, clipped to it.
        let long = progress(&pool, WS, "2026-08-01", "2026-12-01", None, ZONE, TODAY)
            .await
            .unwrap()
            .trend;
        assert_eq!(long.granularity, "week");
        assert_eq!(long.buckets[0].start, "2026-08-01");
        assert_eq!(long.buckets[0].end, "2026-08-02");
        assert_eq!(long.buckets[1].start, "2026-08-03");
        assert_eq!(long.buckets.iter().map(|b| b.completed).sum::<i64>(), 2);
        assert_eq!(long.buckets.last().unwrap().end, "2026-12-01");
    });
}

#[test]
fn progress_enforces_bounds_and_workspace_scope() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        seed(&pool).await;
        for (from, to, project, error) in [
            (
                "2026-11-30",
                "2026-11-01",
                None,
                AnalyticsError::InvalidRange,
            ),
            (
                "2026-01-01",
                "2027-01-02",
                None,
                AnalyticsError::InvalidRange,
            ),
            (
                "2026-02-30",
                "2026-03-01",
                None,
                AnalyticsError::InvalidDate,
            ),
            (
                "2026-11-01",
                "2026-11-30",
                Some("missing"),
                AnalyticsError::NotFound,
            ),
        ] {
            assert_eq!(
                progress(&pool, WS, from, to, project, ZONE, TODAY).await,
                Err(error)
            );
        }
        assert_eq!(
            progress(
                &pool,
                OTHER_WORKSPACE,
                "2026-11-01",
                "2026-11-30",
                Some("p1"),
                ZONE,
                TODAY
            )
            .await,
            Err(AnalyticsError::NotFound)
        );
        let theirs = progress(
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
        assert_eq!(
            (
                theirs.totals.total,
                theirs.projects.len(),
                theirs.deadlines.len()
            ),
            (0, 0, 0)
        );
        assert_eq!(theirs.totals.completion_percent, None);
    });
}
