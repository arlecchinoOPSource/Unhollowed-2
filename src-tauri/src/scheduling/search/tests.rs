use super::*;
use crate::issues::IssueFields;
use crate::scheduling::calendars::{self, CalendarInput};
use crate::scheduling::recurrence::RepeatRule;
use crate::scheduling::{create_event, create_work_block, EventInput, WorkBlockInput};
use crate::test_support::{add_workspace, migrated_pool, DEFAULT_WORKSPACE, OTHER_WORKSPACE};

const TODAY: &str = "2026-11-17";

fn query(text: &str) -> CalendarSearch {
    CalendarSearch {
        text: text.into(),
        time_zone: "UTC".into(),
        today: TODAY.into(),
        include_completed: true,
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

fn timed(title: &str, start: &str, end: &str) -> EventInput {
    EventInput {
        title: title.into(),
        time_zone: Some("UTC".into()),
        start: Some(start.into()),
        end: Some(end.into()),
        ..Default::default()
    }
}

fn paragraph(text: &str) -> String {
    serde_json::json!({
        "type": "doc",
        "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }]
    })
    .to_string()
}

async fn issue(pool: &SqlitePool, workspace: &str, title: &str, note: &str, due: &str) -> String {
    crate::issues::create(
        pool,
        workspace,
        IssueFields {
            title: title.into(),
            description: Some(paragraph(note)),
            due_date: Some(due.into()),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap()
    .summary
    .id
}

async fn find(pool: &SqlitePool, search: CalendarSearch) -> SearchResults {
    search_items(pool, DEFAULT_WORKSPACE, search).await.unwrap()
}

fn titles(results: &SearchResults) -> Vec<&str> {
    results
        .items
        .iter()
        .map(|item| item.title.as_str())
        .collect()
}

#[test]
fn title_and_description_matches_return_the_event_and_its_date() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let mut input = all_day("Quarterly review", "2026-12-03", "2026-12-04");
        input.description = "Bring the École budget".into();
        let event = create_event(&pool, DEFAULT_WORKSPACE, input).await.unwrap();
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            all_day("Lunch", "2026-12-04", "2026-12-05"),
        )
        .await
        .unwrap();

        for text in ["QUARTERLY", "  review ", "école budget", "ÉCOLE"] {
            let results = find(&pool, query(text)).await;
            assert_eq!(titles(&results), ["Quarterly review"], "{text}");
            let item = &results.items[0];
            assert_eq!(item.event_id.as_deref(), Some(event.id.as_str()));
            assert_eq!(item.start_date.as_deref(), Some("2026-12-03"));
        }
        assert!(find(&pool, query("absent")).await.items.is_empty());
    });
}

#[test]
fn results_run_forward_from_today_then_back() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for (title, start, end) in [
            ("Past old", "2026-10-01", "2026-10-02"),
            ("Past recent", "2026-11-10", "2026-11-11"),
            ("Later", "2026-12-20", "2026-12-21"),
            ("Soon", "2026-11-18", "2026-11-19"),
            ("Today", "2026-11-17", "2026-11-18"),
        ] {
            create_event(&pool, DEFAULT_WORKSPACE, all_day(title, start, end))
                .await
                .unwrap();
        }
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed("Timed soon", "2026-11-18T09:00", "2026-11-18T10:00"),
        )
        .await
        .unwrap();
        // Ended just before today began.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            timed("Timed past", "2026-11-16T22:00", "2026-11-17T00:00"),
        )
        .await
        .unwrap();

        // Blank text lists everything, which is how upcoming items are found.
        let results = find(&pool, query("")).await;
        assert_eq!(
            titles(&results),
            [
                "Today",
                "Soon",
                "Timed soon",
                "Later",
                "Timed past",
                "Past recent",
                "Past old"
            ]
        );
        assert_eq!(results.upcoming, 4);
        assert!(!results.truncated);
    });
}

#[test]
fn deadlines_work_blocks_and_completed_issues_are_filtered_together() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let open = issue(&pool, DEFAULT_WORKSPACE, "Ship plan", "", "2026-11-20").await;
        let done = issue(&pool, DEFAULT_WORKSPACE, "Ship report", "", "2026-11-21").await;
        crate::issues::set_status(&pool, DEFAULT_WORKSPACE, &done, "done")
            .await
            .unwrap();
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            all_day("Ship party", "2026-11-22", "2026-11-23"),
        )
        .await
        .unwrap();
        for id in [&open, &done] {
            create_work_block(
                &pool,
                DEFAULT_WORKSPACE,
                WorkBlockInput {
                    issue_id: id.clone(),
                    time_zone: "UTC".into(),
                    start: "2026-11-19T09:00".into(),
                    end: "2026-11-19T10:00".into(),
                },
            )
            .await
            .unwrap();
        }

        let all = find(&pool, query("ship")).await;
        assert_eq!(all.items.len(), 5);
        let kinds = |kinds: &[ItemKind], completed: bool| {
            let mut search = query("ship");
            search.kinds = Some(kinds.to_vec());
            search.include_completed = completed;
            search
        };
        let events = find(&pool, kinds(&[ItemKind::Event], true)).await;
        assert_eq!(titles(&events), ["Ship party"]);
        let deadlines = find(&pool, kinds(&[ItemKind::Deadline], true)).await;
        assert_eq!(titles(&deadlines), ["Ship plan", "Ship report"]);
        let hide_done = find(
            &pool,
            kinds(&[ItemKind::Deadline, ItemKind::WorkBlock], false),
        )
        .await;
        assert_eq!(hide_done.items.len(), 2);
        assert!(hide_done.items.iter().all(|item| !item.closed));
        // No kinds chosen means nothing, not everything.
        assert!(find(&pool, kinds(&[], true)).await.items.is_empty());
    });
}

#[test]
fn issue_descriptions_match_and_calendars_narrow_only_events() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        issue(
            &pool,
            DEFAULT_WORKSPACE,
            "Taxes",
            "File the annual return",
            "2026-11-25",
        )
        .await;
        let work = calendars::create(
            &pool,
            DEFAULT_WORKSPACE,
            CalendarInput {
                name: "Work".into(),
                color: "green".into(),
                description: None,
            },
        )
        .await
        .unwrap();
        let mut input = all_day("Annual offsite", "2026-12-01", "2026-12-02");
        input.calendar_id = Some(work.id.clone());
        create_event(&pool, DEFAULT_WORKSPACE, input).await.unwrap();
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            all_day("Annual checkup", "2026-12-02", "2026-12-03"),
        )
        .await
        .unwrap();

        assert_eq!(
            titles(&find(&pool, query("annual")).await),
            ["Taxes", "Annual offsite", "Annual checkup"]
        );
        let mut narrowed = query("annual");
        narrowed.calendar_ids = Some(vec![work.id.clone()]);
        assert_eq!(
            titles(&find(&pool, narrowed).await),
            ["Taxes", "Annual offsite"]
        );
        let mut none = query("annual");
        none.calendar_ids = Some(Vec::new());
        assert_eq!(titles(&find(&pool, none).await), ["Taxes"]);

        // Hidden calendars are left out, as in calendar views.
        calendars::set_hidden(&pool, DEFAULT_WORKSPACE, &work.id, true)
            .await
            .unwrap();
        assert_eq!(
            titles(&find(&pool, query("annual")).await),
            ["Taxes", "Annual checkup"]
        );
    });
}

#[test]
fn search_stays_inside_the_active_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        create_event(
            &pool,
            OTHER_WORKSPACE,
            all_day("Secret plan", "2026-12-01", "2026-12-02"),
        )
        .await
        .unwrap();
        issue(&pool, OTHER_WORKSPACE, "Secret deadline", "", "2026-12-03").await;
        let mine = create_event(
            &pool,
            DEFAULT_WORKSPACE,
            all_day("Secret mine", "2026-12-04", "2026-12-05"),
        )
        .await
        .unwrap();

        let results = find(&pool, query("secret")).await;
        assert_eq!(titles(&results), ["Secret mine"]);
        assert_eq!(results.items[0].event_id.as_deref(), Some(mine.id.as_str()));
        // Another workspace's calendar ID narrows to nothing, not to its events.
        let other = crate::scheduling::calendars_of(&pool, OTHER_WORKSPACE)
            .await
            .unwrap();
        let mut foreign = query("secret");
        foreign.calendar_ids = Some(vec![other[0].id.clone()]);
        assert!(find(&pool, foreign).await.items.is_empty());
    });
}

#[test]
fn a_repeating_series_is_one_result_and_is_never_expanded_in_full() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let mut daily = timed("Standup", "2026-01-05T09:00", "2026-01-05T09:15");
        daily.repeat = Some(RepeatRule {
            freq: "daily".into(),
            interval: 1,
            count: None,
            until: None,
        });
        create_event(&pool, DEFAULT_WORKSPACE, daily).await.unwrap();
        let mut ended = all_day("Retro", "2026-02-02", "2026-02-03");
        ended.repeat = Some(RepeatRule {
            freq: "weekly".into(),
            interval: 1,
            count: Some(3),
            until: None,
        });
        create_event(&pool, DEFAULT_WORKSPACE, ended).await.unwrap();
        let mut ancient = all_day("Retro ancient", "2020-02-02", "2020-02-03");
        ancient.repeat = Some(RepeatRule {
            freq: "weekly".into(),
            interval: 1,
            count: Some(2),
            until: None,
        });
        create_event(&pool, DEFAULT_WORKSPACE, ancient)
            .await
            .unwrap();

        let standup = find(&pool, query("standup")).await;
        assert_eq!(standup.items.len(), 1);
        assert_eq!(standup.upcoming, 1);
        let next = &standup.items[0];
        assert!(next.recurring);
        assert_eq!(next.start.as_deref(), Some("2026-11-17T09:00"));
        assert_eq!(next.occurrence.as_deref(), Some("2026-11-17T09:00"));

        // Ended series show their latest occurrence, or where they began.
        let retro = find(&pool, query("retro")).await;
        assert_eq!(titles(&retro), ["Retro", "Retro ancient"]);
        assert_eq!(retro.upcoming, 0);
        assert_eq!(retro.items[0].start_date.as_deref(), Some("2026-02-16"));
        assert_eq!(retro.items[1].start_date.as_deref(), Some("2020-02-02"));
        assert_eq!(retro.items[1].occurrence.as_deref(), Some("2020-02-02"));
    });
}

#[test]
fn occurrence_changes_decide_which_occurrence_is_shown() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let mut daily = all_day("Water plants", "2026-11-01", "2026-11-02");
        daily.repeat = Some(RepeatRule {
            freq: "daily".into(),
            interval: 1,
            count: None,
            until: None,
        });
        let event = create_event(&pool, DEFAULT_WORKSPACE, daily).await.unwrap();
        crate::scheduling::recurrence::cancel_occurrence(
            &pool,
            DEFAULT_WORKSPACE,
            &event.id,
            "2026-11-17",
        )
        .await
        .unwrap();
        let results = find(&pool, query("water")).await;
        assert_eq!(results.items[0].start_date.as_deref(), Some("2026-11-18"));
    });
}

#[test]
fn the_cap_keeps_the_nearest_results_and_reports_truncation() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for day in 1..=120 {
            let start = format!("2027-01-{:02}", (day % 28) + 1);
            let start = time::date(&start).unwrap();
            let start = time::add_days(start, (day / 28) * 28).unwrap();
            let end = time::add_days(start, 1).unwrap();
            create_event(
                &pool,
                DEFAULT_WORKSPACE,
                all_day(
                    &format!("Block {day:03}"),
                    &start.to_string(),
                    &end.to_string(),
                ),
            )
            .await
            .unwrap();
        }
        let first = find(&pool, query("block")).await;
        assert_eq!(first.items.len(), SEARCH_LIMIT);
        assert!(first.truncated);
        let dates: Vec<_> = first
            .items
            .iter()
            .map(|item| item.start_date.clone().unwrap())
            .collect();
        let mut sorted = dates.clone();
        sorted.sort();
        assert_eq!(dates, sorted);
        // Repeating the search returns the same results in the same order.
        let again = find(&pool, query("block")).await;
        assert_eq!(first, again);
        // Narrowing the text shrinks the list and clears the flag.
        let narrow = find(&pool, query("block 0")).await;
        assert!(!narrow.truncated);
    });
}

#[test]
fn bad_input_is_refused_or_matches_nothing() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let mut zone = query("x");
        zone.time_zone = "Nowhere/Land".into();
        assert_eq!(
            search_items(&pool, DEFAULT_WORKSPACE, zone).await,
            Err(SchedulingError::InvalidTimeZone)
        );
        let mut day = query("x");
        day.today = "yesterday".into();
        assert_eq!(
            search_items(&pool, DEFAULT_WORKSPACE, day).await,
            Err(SchedulingError::InvalidDate)
        );
        assert!(find(&pool, query(&"x".repeat(201))).await.items.is_empty());
        // Wildcards are literal text, never patterns.
        create_event(
            &pool,
            DEFAULT_WORKSPACE,
            all_day("100% sure", "2026-12-01", "2026-12-02"),
        )
        .await
        .unwrap();
        assert!(find(&pool, query("%%")).await.items.is_empty());
        assert_eq!(titles(&find(&pool, query("100%")).await), ["100% sure"]);
    });
}

/// 5,000 events, 2,000 dated issues and a never-ending daily series, which
/// is more than a personal workspace holds. Results must be the nearest
/// matches, found without reading the whole history into memory.
#[test]
fn a_large_workspace_returns_the_nearest_matches_and_stays_bounded() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let calendar = crate::scheduling::calendars_of(&pool, DEFAULT_WORKSPACE)
            .await
            .unwrap()
            .remove(0)
            .id;
        let mut tx = pool.begin().await.unwrap();
        for index in 0..5000 {
            // One event a day over about thirteen years, around TODAY.
            let start = time::add_days(time::date("2020-01-01").unwrap(), index).unwrap();
            let end = time::add_days(start, 1).unwrap();
            sqlx::query(
                "INSERT INTO events (id, workspace_id, calendar_id, title, description, all_day, start_date, end_date)
                 VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
            )
            .bind(format!("event-{index:05}"))
            .bind(DEFAULT_WORKSPACE)
            .bind(&calendar)
            .bind(format!("Planning {index}"))
            .bind(if index % 7 == 0 { "weekly sync notes" } else { "" })
            .bind(start.to_string())
            .bind(end.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
        let mut daily = timed("Planning standup", "2020-01-01T09:00", "2020-01-01T09:15");
        daily.repeat = Some(RepeatRule {
            freq: "daily".into(),
            interval: 1,
            count: None,
            until: None,
        });
        create_event(&pool, DEFAULT_WORKSPACE, daily).await.unwrap();
        for index in 0..2000 {
            let due = time::add_days(time::date("2026-01-01").unwrap(), index % 700).unwrap();
            issue(
                &pool,
                DEFAULT_WORKSPACE,
                &format!("Planning task {index}"),
                "",
                &due.to_string(),
            )
            .await;
        }

        let started = std::time::Instant::now();
        let results = find(&pool, query("planning")).await;
        eprintln!("large search took {:?}", started.elapsed());
        assert_eq!(results.items.len(), SEARCH_LIMIT);
        assert!(results.truncated);
        assert!(results.upcoming > 0);
        // The standup series appears once, as its next occurrence.
        let standups: Vec<_> = results
            .items
            .iter()
            .filter(|item| item.title == "Planning standup")
            .collect();
        assert_eq!(standups.len(), 1);
        assert_eq!(standups[0].start.as_deref(), Some("2026-11-17T09:00"));
        // Upcoming results are in date order and none lies before today.
        let upcoming = &results.items[..results.upcoming];
        let dates: Vec<_> = upcoming
            .iter()
            .map(|item| item.start_date.clone().or(item.start.clone()).unwrap())
            .collect();
        let mut sorted = dates.clone();
        sorted.sort();
        assert_eq!(dates, sorted);
        assert!(dates.iter().all(|date| date.as_str() >= TODAY));

        // About 715 events share a description, so the cap applies again, and
        // the nearest of them lead.
        let notes = find(&pool, query("weekly sync")).await;
        assert!(notes.truncated);
        assert_eq!(notes.items.len(), SEARCH_LIMIT);
        assert!(notes.upcoming > 0);
        assert!(notes.items[0].start_date.as_deref() >= Some(TODAY));
    });
}
