//! A repeatable timing fixture for the queries behind each main page.
//!
//! Run with
//! `cargo test --release --manifest-path src-tauri/Cargo.toml perf_tests -- --ignored --nocapture`.
//! It builds disposable file databases of 500 issues (a representative
//! personal workspace) and 5,000 issues (headroom), then times each query
//! the pages send. `docs/PERFORMANCE.md` records the results.

use crate::issues::{IssueFilter, IssueQuery};
use crate::relationships::{add, RelationKind};
use crate::test_support::{add_project, migrator, TempDatabase, DEFAULT_WORKSPACE};
use sqlx::SqlitePool;
use std::time::{Duration, Instant};

const TODAY: &str = "2026-11-16";
const STATUSES: [&str; 5] = ["todo", "in_progress", "blocked", "done", "canceled"];

/// Projects, labels, workspace milestones, issues spread across them with
/// due dates over three months, parent links, and one objective.
async fn fixture(pool: &SqlitePool, count: usize) -> String {
    let mut projects = Vec::new();
    for index in 0..12 {
        projects.push(add_project(pool, DEFAULT_WORKSPACE, &format!("Project {index}")).await);
    }
    let mut labels = Vec::new();
    for index in 0..8 {
        let label = crate::labels::create(
            pool,
            DEFAULT_WORKSPACE,
            crate::labels::LabelInput {
                name: format!("Label {index}"),
                description: None,
                color: "blue".into(),
            },
        )
        .await
        .unwrap();
        labels.push(label.id);
    }
    let mut milestones = Vec::new();
    for index in 0..12 {
        let milestone = crate::milestones::create(
            pool,
            DEFAULT_WORKSPACE,
            crate::milestones::MilestoneInput {
                title: format!("Milestone {index}"),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        milestones.push(milestone.id);
    }
    let mut ids: Vec<String> = Vec::with_capacity(count);
    for index in 0..count {
        // One in thirteen issues is in the Inbox.
        let project = projects.get(index % 13).map(String::as_str);
        let id = crate::issues::create(
            pool,
            DEFAULT_WORKSPACE,
            crate::issues::IssueFields {
                title: format!("Issue {index} about launch plans"),
                due_date: (index % 4 != 0)
                    .then(|| format!("2026-{:02}-{:02}", 10 + index % 3, 1 + index % 28)),
                priority: Some(["none", "low", "medium", "high", "urgent"][index % 5].into()),
                ..Default::default()
            },
            project,
        )
        .await
        .unwrap()
        .summary
        .id;
        let status = STATUSES[index % STATUSES.len()];
        if status != "todo" {
            crate::issues::set_status(pool, DEFAULT_WORKSPACE, &id, status)
                .await
                .unwrap();
        }
        if index % 2 == 0 {
            crate::issues::set_labels(
                pool,
                DEFAULT_WORKSPACE,
                &id,
                vec![labels[index % 8].clone(), labels[(index + 3) % 8].clone()],
            )
            .await
            .unwrap();
        }
        if index % 3 == 0 {
            crate::issues::set_milestone(
                pool,
                DEFAULT_WORKSPACE,
                &id,
                Some(&milestones[index % 12]),
            )
            .await
            .unwrap();
        }
        // Every tenth issue is a sub-issue of the one before it, in the
        // same project.
        if index % 10 == 1 && index % 13 != 0 && (index - 1) % 13 == index % 13 {
            add(
                pool,
                DEFAULT_WORKSPACE,
                &id,
                &ids[index - 1],
                RelationKind::Parent,
            )
            .await
            .unwrap();
        }
        ids.push(id);
    }
    let project = projects[1].clone();
    sqlx::query(
        "INSERT INTO missions (id, project_id, title, description) VALUES ('m', ?, 'M', '')",
    )
    .bind(&project)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO objectives (id, project_id, mission_id, title, description)
         VALUES ('o', ?, 'm', 'O', '')",
    )
    .bind(&project)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO objective_issues (objective_id, issue_id)
         SELECT 'o', id FROM issues WHERE project_id = ? LIMIT 20",
    )
    .bind(&project)
    .execute(pool)
    .await
    .unwrap();
    project
}

fn query(filter: IssueFilter, sort: &str, limit: u32) -> IssueQuery {
    IssueQuery {
        filter,
        sort: Some(sort.into()),
        limit: Some(limit),
        ..Default::default()
    }
}

/// Times `$body` as the mean of 20 runs after one warm-up.
macro_rules! time {
    ($rows:ident, $name:expr, $body:expr) => {{
        $body.await.unwrap();
        let start = Instant::now();
        for _ in 0..20 {
            $body.await.unwrap();
        }
        $rows.push(($name, start.elapsed() / 20));
    }};
}

async fn measure_size(count: usize) -> Vec<(&'static str, Duration)> {
    let database = TempDatabase::new(&format!("perf-{count}"));
    let pool = database.open().await;
    migrator(i64::MAX).await.run(&pool).await.unwrap();
    let project = fixture(&pool, count).await;
    let ws = DEFAULT_WORKSPACE;
    let open = || IssueFilter {
        state: Some("open".into()),
        ..Default::default()
    };
    let mut rows = Vec::new();
    time!(
        rows,
        "Issues: first page (open, updated)",
        crate::issues::query(&pool, ws, query(open(), "updated", 50))
    );
    time!(
        rows,
        "Issues: text search",
        crate::issues::query(
            &pool,
            ws,
            query(
                IssueFilter {
                    text: Some("launch plans 4".into()),
                    ..open()
                },
                "updated",
                50
            )
        )
    );
    time!(
        rows,
        "Issues: label + priority filters",
        crate::issues::query(
            &pool,
            ws,
            query(
                IssueFilter {
                    priorities: vec!["high".into()],
                    label_ids: vec![crate::labels::list(&pool, ws).await.unwrap()[0].id.clone()],
                    ..open()
                },
                "priority",
                50
            )
        )
    );
    time!(
        rows,
        "Board: one status column",
        crate::issues::query(
            &pool,
            ws,
            query(
                IssueFilter {
                    state: Some("all".into()),
                    statuses: vec!["in_progress".into()],
                    ..Default::default()
                },
                "updated",
                100
            )
        )
    );
    time!(
        rows,
        "Today: due today or overdue",
        crate::issues::query(
            &pool,
            ws,
            query(
                IssueFilter {
                    due_before: Some(TODAY.into()),
                    undated: Some("exclude".into()),
                    ..open()
                },
                "due",
                200
            )
        )
    );
    time!(
        rows,
        "Calendar: one month",
        crate::issues::query(
            &pool,
            ws,
            query(
                IssueFilter {
                    state: Some("all".into()),
                    due_after: Some("2026-11-01".into()),
                    due_before: Some("2026-11-30".into()),
                    undated: Some("exclude".into()),
                    ..Default::default()
                },
                "due",
                200
            )
        )
    );
    time!(
        rows,
        "Project overview",
        crate::overview::overview(&pool, ws, &project, TODAY)
    );
    time!(
        rows,
        "Project goals with rollups",
        crate::goals::load(&pool, ws, &project)
    );
    time!(
        rows,
        "Milestones with counts",
        crate::milestones::list(&pool, ws)
    );
    time!(
        rows,
        "Workspace search",
        crate::search::search(&pool, ws, "launch")
    );
    time!(
        rows,
        "All issues (relationship picker)",
        crate::issues::list(&pool, ws, None)
    );
    time!(rows, "JSON export", crate::portability::export(&pool, ws));
    pool.close().await;
    rows
}

#[test]
#[ignore]
fn measure() {
    tauri::async_runtime::block_on(async {
        let small = measure_size(500).await;
        let large = measure_size(5000).await;
        println!("\n| Query | 500 issues | 5,000 issues |\n|---|---:|---:|");
        for ((name, a), (_, b)) in small.iter().zip(&large) {
            println!(
                "| {name} | {:.2} ms | {:.2} ms |",
                a.as_secs_f64() * 1000.0,
                b.as_secs_f64() * 1000.0
            );
        }
    });
}

// --- Calendar ---------------------------------------------------------------

use crate::scheduling::{
    self, ics, links, recurrence::RepeatRule, reminders, search::CalendarSearch, EventInput,
    ItemRange, WorkBlockInput,
};

/// A schedule of `events` single events across a year, one repeating series
/// per ten of them (daily, weekly, and monthly, some with a cancelled and a
/// changed occurrence), a work block and a deadline for every issue, a
/// reminder on one event in four, and a document and project link on one in
/// five. Returns the IDs of the issues, for reuse.
async fn calendar_fixture(pool: &SqlitePool, events: usize) {
    let ws = DEFAULT_WORKSPACE;
    let project = add_project(pool, ws, "Schedule").await;
    let document = crate::documents::create(pool, ws, Some("Notes"))
        .await
        .unwrap()
        .id;
    let zones = ["Europe/Paris", "America/New_York", "Asia/Tokyo", "UTC"];
    for index in 0..events {
        let month = 1 + index % 12;
        let day = 1 + index % 28;
        let hour = 8 + index % 9;
        let zone = zones[index % zones.len()];
        let mut input = EventInput {
            title: format!("Meeting {index} about launch plans"),
            description: "Agenda and notes for the launch plans meeting.".into(),
            location: (index % 3 == 0).then(|| "Room 4".into()),
            ..Default::default()
        };
        if index % 7 == 0 {
            input.all_day = true;
            input.start_date = Some(format!("2026-{month:02}-{day:02}"));
            input.end_date = Some(format!("2026-{month:02}-{:02}", day + 1));
        } else {
            input.time_zone = Some(zone.into());
            input.start = Some(format!("2026-{month:02}-{day:02}T{hour:02}:00"));
            input.end = Some(format!("2026-{month:02}-{day:02}T{hour:02}:45"));
        }
        let series = index % 10 == 0;
        if series {
            input.repeat = Some(RepeatRule {
                freq: ["daily", "weekly", "monthly"][index / 10 % 3].into(),
                interval: 1 + (index / 30) as i64 % 3,
                count: (index % 20 == 0).then_some(200),
                until: None,
            });
        }
        let event = scheduling::create_event(pool, ws, input).await.unwrap();
        if series && index % 20 == 0 && event.time_zone.is_some() {
            let key = event.start_local.clone().unwrap();
            scheduling::recurrence::cancel_occurrence(pool, ws, &event.id, &key)
                .await
                .unwrap();
        }
        if index % 4 == 0 && !event.all_day {
            reminders::set_reminder(pool, ws, &event.id, Some(15))
                .await
                .unwrap();
        }
        if index % 5 == 0 {
            links::link(pool, ws, &event.id, links::Target::Document, &document)
                .await
                .unwrap();
            links::link(pool, ws, &event.id, links::Target::Project, &project)
                .await
                .unwrap();
        }
    }
    // Issues with deadlines and work blocks spread over the same year.
    for index in 0..events / 2 {
        let id = crate::issues::create(
            pool,
            ws,
            crate::issues::IssueFields {
                title: format!("Issue {index} about launch plans"),
                due_date: Some(format!("2026-{:02}-{:02}", 1 + index % 12, 1 + index % 28)),
                ..Default::default()
            },
            Some(&project),
        )
        .await
        .unwrap()
        .summary
        .id;
        scheduling::create_work_block(
            pool,
            ws,
            WorkBlockInput {
                issue_id: id,
                time_zone: "Europe/Paris".into(),
                start: format!("2026-{:02}-{:02}T14:00", 1 + index % 12, 1 + index % 28),
                end: format!("2026-{:02}-{:02}T15:30", 1 + index % 12, 1 + index % 28),
            },
        )
        .await
        .unwrap();
    }
}

fn window(from: &str, to: &str) -> ItemRange {
    ItemRange {
        from: from.into(),
        to: to.into(),
        time_zone: "Europe/Paris".into(),
    }
}

fn search(text: &str) -> CalendarSearch {
    CalendarSearch {
        text: text.into(),
        time_zone: "Europe/Paris".into(),
        today: "2026-06-15".into(),
        kinds: None,
        calendar_ids: None,
        include_completed: false,
    }
}

async fn measure_calendar(events: usize) -> Vec<(&'static str, Duration)> {
    let database = TempDatabase::new(&format!("perf-calendar-{events}"));
    let pool = database.open().await;
    migrator(i64::MAX).await.run(&pool).await.unwrap();
    let build = Instant::now();
    calendar_fixture(&pool, events).await;
    println!("built {events} events in {:.1?}", build.elapsed());
    let ws = DEFAULT_WORKSPACE;
    let mut rows = Vec::new();
    time!(
        rows,
        "Day view",
        scheduling::list_items(&pool, ws, window("2026-06-15", "2026-06-16"))
    );
    time!(
        rows,
        "Week view",
        scheduling::list_items(&pool, ws, window("2026-06-15", "2026-06-22"))
    );
    time!(
        rows,
        "Month view (six weeks)",
        scheduling::list_items(&pool, ws, window("2026-05-25", "2026-07-06"))
    );
    time!(
        rows,
        "Search: text",
        scheduling::search::search_items(&pool, ws, search("launch plans 4"))
    );
    time!(
        rows,
        "Search: blank (upcoming)",
        scheduling::search::search_items(&pool, ws, search(""))
    );
    time!(
        rows,
        "Reminders: check for due ones",
        reminders::claim_due(&pool, ws, "2026-06-15T07:50:00Z".parse().unwrap())
    );
    let first = scheduling::list_items(&pool, ws, window("2026-06-01", "2026-06-30"))
        .await
        .unwrap()
        .items
        .into_iter()
        .find_map(|item| item.event_id)
        .unwrap();
    time!(rows, "Event links", links::links(&pool, ws, &first));
    // Whole-file operations run once, since they are not on a page's path.
    let start = Instant::now();
    let (file, written) = ics::export(&pool, ws).await.unwrap();
    rows.push(("ICS export (all events)", start.elapsed()));
    let target = crate::test_support::migrated_pool().await;
    let start = Instant::now();
    let report = ics::import(&target, ws, &file, None, "Europe/Paris", true)
        .await
        .unwrap();
    rows.push(("ICS import (all events)", start.elapsed()));
    println!(
        "ics: {written} events, {:.1} KiB, imported {}, skipped {}",
        file.len() as f64 / 1024.0,
        report.imported.len(),
        report.skipped.len()
    );
    pool.close().await;
    rows
}

#[test]
#[ignore]
fn measure_calendar_sizes() {
    tauri::async_runtime::block_on(async {
        let small = measure_calendar(500).await;
        let large = measure_calendar(5000).await;
        println!("\n| Operation | 500 events | 5,000 events |\n|---|---:|---:|");
        for ((name, a), (_, b)) in small.iter().zip(&large) {
            println!(
                "| {name} | {:.2} ms | {:.2} ms |",
                a.as_secs_f64() * 1000.0,
                b.as_secs_f64() * 1000.0
            );
        }
    });
}

/// Habits for `years` of history: 30 habits, five archived, each checked on
/// roughly seven days in ten, plus a check-in every other day. Everything is
/// inserted with set-based SQL so the fixture builds quickly.
async fn habit_fixture(pool: &SqlitePool, habits: usize, years: i64) {
    let days = years * 365;
    for index in 0..habits {
        let archived = index % 6 == 5;
        sqlx::query(
            "INSERT INTO habits (id, workspace_id, name, name_key, position, start_date, archived_on)
             VALUES (?1, ?2, ?3, lower(?3), ?4, date(?5, ?6), CASE WHEN ?7 THEN date(?5, '-30 days') END)",
        )
        .bind(format!("habit-{index}"))
        .bind(DEFAULT_WORKSPACE)
        .bind(format!("Habit {index}"))
        .bind(index as i64)
        .bind(TODAY)
        .bind(format!("-{days} days"))
        .bind(archived)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM d WHERE n < ?1)
         INSERT INTO habit_completions (habit_id, workspace_id, date)
         SELECT h.id, h.workspace_id, date(h.start_date, '+' || d.n || ' days')
         FROM habits AS h JOIN d
         WHERE date(h.start_date, '+' || d.n || ' days') <= coalesce(h.archived_on, ?2)
           AND ((d.n * 7 + h.position * 3) % 10) < 7",
    )
    .bind(days)
    .bind(TODAY)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM d WHERE n < ?1)
         INSERT INTO daily_checkins (id, workspace_id, date, mood, energy, focus)
         SELECT 'checkin-' || n, ?2, date(?3, '-' || n || ' days'),
                1 + n % 5, CASE WHEN n % 3 = 0 THEN NULL ELSE 1 + (n + 1) % 5 END, 1 + (n + 2) % 5
         FROM d WHERE n % 2 = 0",
    )
    .bind(days)
    .bind(DEFAULT_WORKSPACE)
    .bind(TODAY)
    .execute(pool)
    .await
    .unwrap();
}

async fn measure_habits(habits: usize, years: i64) -> (Vec<(&'static str, Duration)>, (i64, i64)) {
    let database = TempDatabase::new(&format!("perf-habits-{habits}-{years}"));
    let pool = database.open().await;
    migrator(i64::MAX).await.run(&pool).await.unwrap();
    habit_fixture(&pool, habits, years).await;
    let completions: i64 = sqlx::query_scalar("SELECT count(*) FROM habit_completions")
        .fetch_one(&pool)
        .await
        .unwrap();
    let checkins: i64 = sqlx::query_scalar("SELECT count(*) FROM daily_checkins")
        .fetch_one(&pool)
        .await
        .unwrap();
    let ws = DEFAULT_WORKSPACE;
    let (from_30, from_366) = ("2026-10-18", "2025-11-17");
    let mut rows = Vec::new();
    macro_rules! time {
        ($name:expr, $runs:expr, $call:expr) => {{
            $call.await.unwrap();
            let start = Instant::now();
            for _ in 0..$runs {
                $call.await.unwrap();
            }
            rows.push(($name, start.elapsed() / $runs));
        }};
    }
    time!("Habits: list", 20, crate::habits::list(&pool, ws));
    time!(
        "Grid: one month",
        20,
        crate::habits::month(&pool, ws, 2026, 11, TODAY)
    );
    time!(
        "History: one habit, all days",
        20,
        crate::habits::history(&pool, ws, "habit-0")
    );
    time!(
        "Statistics: 30 days",
        10,
        crate::habits::stats::statistics(&pool, ws, from_30, TODAY, None, TODAY)
    );
    time!(
        "Statistics: 366 days",
        10,
        crate::habits::stats::statistics(&pool, ws, from_366, TODAY, None, TODAY)
    );
    time!(
        "Check-in trends: 366 days",
        10,
        crate::checkins::analytics::analytics(&pool, ws, from_366, TODAY, true, TODAY)
    );
    time!(
        "Dashboard analytics: 30 days",
        10,
        crate::analytics::workspace_analytics(&pool, ws, from_30, TODAY, None, "UTC", TODAY)
    );
    time!(
        "Dashboard analytics: 366 days",
        10,
        crate::analytics::workspace_analytics(&pool, ws, from_366, TODAY, None, "UTC", TODAY)
    );
    time!(
        "Backup: export all history",
        5,
        crate::habits::backup::backup_json(&pool, ws)
    );
    let (backup, ..) = crate::habits::backup::backup_json(&pool, ws).await.unwrap();
    let folder = std::env::temp_dir().join(format!("perf-habit-copies-{habits}-{years}"));
    let start = Instant::now();
    let preview = crate::habits::backup::restore(&pool, ws, &backup, None, &folder)
        .await
        .unwrap();
    rows.push(("Restore: preview", start.elapsed()));
    let start = Instant::now();
    crate::habits::backup::restore(&pool, ws, &backup, Some(&preview.token), &folder)
        .await
        .unwrap();
    rows.push(("Restore: replace all history", start.elapsed()));
    let _ = std::fs::remove_dir_all(&folder);
    pool.close().await;
    (rows, (completions, checkins))
}

#[test]
#[ignore]
fn measure_habit_sizes() {
    tauri::async_runtime::block_on(async {
        let (small, small_size) = measure_habits(10, 1).await;
        let (large, large_size) = measure_habits(30, 5).await;
        println!(
            "\nSmall: 10 habits, 1 year, {} completions, {} check-ins. Large: 30 habits, 5 years, {} completions, {} check-ins.",
            small_size.0, small_size.1, large_size.0, large_size.1
        );
        println!("\n| Operation | Small | Large |\n|---|---:|---:|");
        for ((name, a), (_, b)) in small.iter().zip(&large) {
            println!(
                "| {name} | {:.2} ms | {:.2} ms |",
                a.as_secs_f64() * 1000.0,
                b.as_secs_f64() * 1000.0
            );
        }
    });
}

// --- Dashboard --------------------------------------------------------------

/// One workspace holding everything a heavy dashboard reads: 5,000 issues in
/// 12 projects with milestones and an objective, a year of 500 events (with
/// repeating series, work blocks, and deadlines), and 30 habits with five
/// years of completions and check-ins. Returns how long the fixture took.
async fn dashboard_fixture(pool: &SqlitePool) -> Duration {
    let start = Instant::now();
    fixture(pool, 5000).await;
    calendar_fixture(pool, 500).await;
    habit_fixture(pool, 30, 5).await;
    start.elapsed()
}

#[test]
#[ignore]
fn measure_dashboard() {
    use crate::analytics::{progress::progress, schedule::schedule, workspace_analytics};
    use crate::checkins::analytics::analytics as mood;
    use crate::habits::stats::statistics;
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("perf-dashboard");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let built = dashboard_fixture(&pool).await;
        let count = |table: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };
        println!(
            "\nFixture built in {built:.1?}: {} issues, {} projects, {} events, {} work blocks, {} habits, {} completions, {} check-ins.",
            count("issues").await,
            count("projects").await,
            count("events").await,
            count("work_blocks").await,
            count("habits").await,
            count("habit_completions").await,
            count("daily_checkins").await
        );
        let ws = DEFAULT_WORKSPACE;
        let zone = "Europe/Paris";
        let one_project: String =
            sqlx::query_scalar("SELECT id FROM projects ORDER BY name LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        let mut rows: Vec<(&'static str, Duration)> = Vec::new();
        for (label, from) in [("30 days", "2026-10-18"), ("366 days", "2025-11-17")] {
            let to = "2026-11-16";
            macro_rules! t {
                ($name:expr, $call:expr) => {{
                    $call.await.unwrap();
                    let start = Instant::now();
                    for _ in 0..10 {
                        $call.await.unwrap();
                    }
                    rows.push((
                        Box::leak(format!("{} ({label})", $name).into_boxed_str()) as &str,
                        start.elapsed() / 10,
                    ));
                }};
            }
            t!(
                "Workspace analytics (all sections)",
                workspace_analytics(&pool, ws, from, to, None, zone, TODAY)
            );
            t!(
                "Workspace analytics, one project",
                workspace_analytics(&pool, ws, from, to, Some(&one_project), zone, TODAY)
            );
            t!(
                "Progress analytics",
                progress(&pool, ws, from, to, None, zone, TODAY)
            );
            t!(
                "Schedule analytics",
                schedule(&pool, ws, from, to, None, zone, TODAY)
            );
            t!(
                "Habit statistics",
                statistics(&pool, ws, from, to, None, TODAY)
            );
            t!("Mood analytics", mood(&pool, ws, from, to, false, TODAY));
        }
        println!("\n| Read | Time |\n|---|---:|");
        for (name, time) in &rows {
            println!("| {name} | {:.2} ms |", time.as_secs_f64() * 1000.0);
        }
        pool.close().await;
    });
}
