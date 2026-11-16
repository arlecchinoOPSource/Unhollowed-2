use super::*;
use crate::issues::{create, reopen, set_status, set_status_on, IssueFields};
use crate::test_support::{
    add_workspace, memory_pool, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE,
    OTHER_WORKSPACE,
};

fn rule(frequency: &str, interval: i64) -> Option<RecurrenceInput> {
    Some(RecurrenceInput {
        frequency: frequency.into(),
        interval,
    })
}

async fn recurring(pool: &SqlitePool, title: &str, due: &str, every: (&str, i64)) -> String {
    let issue = create(
        pool,
        DEFAULT_WORKSPACE,
        IssueFields {
            title: title.into(),
            due_date: Some(due.into()),
            ..IssueFields::default()
        },
        None,
    )
    .await
    .unwrap();
    set_rule(
        pool,
        DEFAULT_WORKSPACE,
        &issue.summary.id,
        rule(every.0, every.1),
    )
    .await
    .unwrap();
    issue.summary.id
}

/// Due dates of a series in occurrence order, with their closed state.
async fn series(pool: &SqlitePool, issue: &str) -> Vec<(i64, Option<String>, bool)> {
    sqlx::query_as(
        "SELECT occurrence_index, due_date, closed FROM issues
         WHERE recurrence_id = (SELECT recurrence_id FROM issues WHERE id = ?)
         ORDER BY occurrence_index",
    )
    .bind(issue)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn latest(pool: &SqlitePool, issue: &str) -> String {
    recurrence_for(pool, DEFAULT_WORKSPACE, issue)
        .await
        .unwrap()
        .unwrap()
        .latest_issue_id
}

#[test]
fn civil_dates_round_trip_and_count_days() {
    // Every day from 1900 to 2100 converts to a date and back.
    let start = days_from_civil(1900, 1, 1);
    let end = days_from_civil(2100, 12, 31);
    let mut previous = civil_from_days(start - 1);
    for days in start..=end {
        let (year, month, day) = civil_from_days(days);
        assert_eq!(days_from_civil(year, month, day), days);
        assert!((year, month, day) > previous);
        previous = (year, month, day);
    }
    assert_eq!(add_days("2028-02-28", 1), "2028-02-29");
    assert_eq!(add_days("2027-02-28", 1), "2027-03-01");
    assert_eq!(add_days("2026-12-31", 1), "2027-01-01");
    assert_eq!(days_between("2026-11-01", "2026-11-02"), 1);
    assert_eq!(days_between("2026-03-01", "2026-02-27"), -2);
}

#[test]
fn occurrence_dates_follow_the_anchor_and_clamp_month_ends() {
    assert_eq!(occurrence_date("2026-11-16", "daily", 2, 3), "2026-11-22");
    assert_eq!(occurrence_date("2026-11-16", "weekly", 1, 2), "2026-11-30");
    assert_eq!(occurrence_date("2026-11-16", "weekly", 2, 1), "2026-11-30");
    // Month-end: never drifts to the 28th.
    let month_end: Vec<_> = (0..5)
        .map(|index| occurrence_date("2026-01-31", "monthly", 1, index))
        .collect();
    assert_eq!(
        month_end,
        [
            "2026-01-31",
            "2026-02-28",
            "2026-03-31",
            "2026-04-30",
            "2026-05-31"
        ]
    );
    assert_eq!(occurrence_date("2028-01-31", "monthly", 1, 1), "2028-02-29");
    assert_eq!(occurrence_date("2026-11-30", "monthly", 3, 1), "2027-02-28");
    assert_eq!(occurrence_date("2026-11-15", "monthly", 2, 6), "2027-11-15");
}

#[test]
fn next_index_skips_missed_dates_only_when_today_is_known() {
    assert_eq!(next_index("2026-11-01", "daily", 1, 0, None), 1);
    assert_eq!(
        next_index("2026-11-01", "daily", 1, 0, Some("2026-11-10")),
        9
    );
    // The next date already lies ahead, so nothing is skipped.
    assert_eq!(
        next_index("2026-11-01", "weekly", 1, 0, Some("2026-11-03")),
        1
    );
    // Weekly, three missed weeks: lands on or after today.
    let index = next_index("2026-11-02", "weekly", 1, 0, Some("2026-11-24"));
    assert_eq!(
        occurrence_date("2026-11-02", "weekly", 1, index),
        "2026-11-30"
    );
    let index = next_index("2026-01-31", "monthly", 1, 0, Some("2026-04-01"));
    assert_eq!(
        occurrence_date("2026-01-31", "monthly", 1, index),
        "2026-04-30"
    );
}

#[test]
fn completing_creates_one_next_occurrence_with_copied_fields() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO projects (id, workspace_id, name) VALUES (?, ?, 'Home')")
            .bind(&project)
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .unwrap();
        let first = create(
            &pool,
            DEFAULT_WORKSPACE,
            IssueFields {
                title: "Water plants".into(),
                description: Some(r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Ferns too"}]}]}"#.into()),
                priority: Some("high".into()),
                start_date: Some("2026-11-14".into()),
                due_date: Some("2026-11-16".into()),
            },
            Some(&project),
        )
        .await
        .unwrap()
        .summary
        .id;
        let label = crate::labels::create(
            &pool,
            DEFAULT_WORKSPACE,
            crate::labels::LabelInput {
                name: "Home".into(),
                description: None,
                color: "green".into(),
            },
        )
        .await
        .unwrap();
        let old = crate::labels::create(
            &pool,
            DEFAULT_WORKSPACE,
            crate::labels::LabelInput {
                name: "Old".into(),
                description: None,
                color: "gray".into(),
            },
        )
        .await
        .unwrap();
        crate::issues::set_labels(
            &pool,
            DEFAULT_WORKSPACE,
            &first,
            vec![label.id.clone(), old.id.clone()],
        )
        .await
        .unwrap();
        crate::labels::set_archived(&pool, DEFAULT_WORKSPACE, &old.id, true)
            .await
            .unwrap();

        let tagged = set_rule(&pool, DEFAULT_WORKSPACE, &first, rule("daily", 2))
            .await
            .unwrap();
        assert!(tagged.summary.recurring);
        // Setting the same active rule again changes nothing.
        assert_eq!(
            set_rule(&pool, DEFAULT_WORKSPACE, &first, rule("daily", 2))
                .await
                .unwrap()
                .summary
                .recurrence_id,
            tagged.summary.recurrence_id
        );

        let done = set_status_on(&pool, DEFAULT_WORKSPACE, &first, "done", Some("2026-11-16"))
            .await
            .unwrap();
        assert!(done.summary.closed);
        let next_id = latest(&pool, &first).await;
        let next = crate::issues::get(&pool, DEFAULT_WORKSPACE, &next_id)
            .await
            .unwrap();
        assert_ne!(next.summary.id, first);
        assert_eq!(next.summary.number, done.summary.number + 1);
        assert_eq!(next.summary.title, "Water plants");
        assert_eq!(next.description, done.description);
        assert_eq!(next.summary.priority, "high");
        assert_eq!(next.summary.project_id.as_deref(), Some(project.as_str()));
        assert_eq!(next.summary.status, "todo");
        assert_eq!(next.summary.due_date.as_deref(), Some("2026-11-18"));
        // The start date keeps its two-day lead.
        assert_eq!(next.summary.start_date.as_deref(), Some("2026-11-16"));
        // Only active labels carry over.
        assert_eq!(next.summary.label_ids.0, vec![label.id.clone()]);
        assert!(next.summary.recurring);
        // The new occurrence is searchable.
        let found = crate::issues::query(
            &pool,
            DEFAULT_WORKSPACE,
            crate::issues::IssueQuery {
                filter: crate::issues::IssueFilter {
                    text: Some("ferns".into()),
                    state: Some("open".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(found.issues.len(), 1);
    });
}

#[test]
fn retries_reopening_and_cancellation_never_duplicate_occurrences() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let first = recurring(&pool, "Standup", "2026-11-16", ("weekly", 1)).await;

        set_status_on(&pool, DEFAULT_WORKSPACE, &first, "done", None)
            .await
            .unwrap();
        set_status_on(&pool, DEFAULT_WORKSPACE, &first, "done", None)
            .await
            .unwrap();
        reopen(&pool, DEFAULT_WORKSPACE, &first).await.unwrap();
        set_status_on(&pool, DEFAULT_WORKSPACE, &first, "done", None)
            .await
            .unwrap();
        assert_eq!(
            series(&pool, &first).await,
            [
                (0, Some("2026-11-16".into()), true),
                (1, Some("2026-11-23".into()), false),
            ]
        );
        // Canceling skips an occurrence and still creates the next one.
        let second = latest(&pool, &first).await;
        set_status_on(&pool, DEFAULT_WORKSPACE, &second, "canceled", None)
            .await
            .unwrap();
        assert_eq!(series(&pool, &first).await.len(), 3);
        // Moving between open statuses never creates occurrences.
        let third = latest(&pool, &first).await;
        set_status(&pool, DEFAULT_WORKSPACE, &third, "in_progress")
            .await
            .unwrap();
        set_status(&pool, DEFAULT_WORKSPACE, &third, "blocked")
            .await
            .unwrap();
        assert_eq!(series(&pool, &first).await.len(), 3);
    });
}

#[test]
fn concurrent_completions_create_one_next_occurrence() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("recurrence-concurrent");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let first = recurring(&pool, "Backup", "2026-11-16", ("daily", 1)).await;
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let pool = pool.clone();
                let first = first.clone();
                tauri::async_runtime::spawn(async move {
                    set_status_on(&pool, DEFAULT_WORKSPACE, &first, "done", None)
                        .await
                        .unwrap()
                })
            })
            .collect();
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(series(&pool, &first).await.len(), 2);
        pool.close().await;
    });
}

#[test]
fn missed_dates_are_skipped_and_month_ends_hold() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let daily = recurring(&pool, "Stretch", "2026-11-01", ("daily", 1)).await;
        set_status_on(&pool, DEFAULT_WORKSPACE, &daily, "done", Some("2026-11-10"))
            .await
            .unwrap();
        assert_eq!(
            series(&pool, &daily).await,
            [
                (0, Some("2026-11-01".into()), true),
                (9, Some("2026-11-10".into()), false),
            ]
        );

        let monthly = recurring(&pool, "Pay rent", "2026-01-31", ("monthly", 1)).await;
        let mut current = monthly.clone();
        for _ in 0..3 {
            set_status_on(&pool, DEFAULT_WORKSPACE, &current, "done", None)
                .await
                .unwrap();
            current = latest(&pool, &monthly).await;
        }
        let dates: Vec<_> = series(&pool, &monthly)
            .await
            .into_iter()
            .map(|(_, due, _)| due.unwrap())
            .collect();
        assert_eq!(
            dates,
            ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]
        );

        // Rescheduling one occurrence does not move the series.
        crate::issues::set_due_date(&pool, DEFAULT_WORKSPACE, &current, Some("2026-05-03"))
            .await
            .unwrap();
        set_status_on(&pool, DEFAULT_WORKSPACE, &current, "done", None)
            .await
            .unwrap();
        let next = latest(&pool, &monthly).await;
        assert_eq!(
            crate::issues::get(&pool, DEFAULT_WORKSPACE, &next)
                .await
                .unwrap()
                .summary
                .due_date
                .as_deref(),
            Some("2026-05-31")
        );
    });
}

#[test]
fn stopping_and_editing_rules_keep_past_occurrences() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let first = recurring(&pool, "Review", "2026-11-16", ("weekly", 1)).await;
        set_status_on(&pool, DEFAULT_WORKSPACE, &first, "done", None)
            .await
            .unwrap();
        let second = latest(&pool, &first).await;
        let old_series = crate::issues::get(&pool, DEFAULT_WORKSPACE, &second)
            .await
            .unwrap()
            .summary
            .recurrence_id;

        // Editing starts a new series anchored on this occurrence.
        let edited = set_rule(&pool, DEFAULT_WORKSPACE, &second, rule("monthly", 1))
            .await
            .unwrap();
        assert_ne!(edited.summary.recurrence_id, old_series);
        assert!(!recurrence_for(&pool, DEFAULT_WORKSPACE, &first)
            .await
            .unwrap()
            .unwrap()
            .stopped
            .eq(&false));
        let view = recurrence_for(&pool, DEFAULT_WORKSPACE, &second)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                view.frequency.as_str(),
                view.interval,
                view.anchor_date.as_str()
            ),
            ("monthly", 1, "2026-11-23")
        );
        // The past occurrence stays in its stopped series.
        assert_eq!(
            crate::issues::get(&pool, DEFAULT_WORKSPACE, &first)
                .await
                .unwrap()
                .summary
                .recurrence_id,
            old_series
        );

        // Stopping keeps occurrences and creates no more.
        let stopped = set_rule(&pool, DEFAULT_WORKSPACE, &second, None)
            .await
            .unwrap();
        assert!(!stopped.summary.recurring);
        assert!(stopped.summary.recurrence_id.is_some());
        set_status_on(&pool, DEFAULT_WORKSPACE, &second, "done", None)
            .await
            .unwrap();
        assert_eq!(series(&pool, &second).await.len(), 1);
    });
}

#[test]
fn rejects_invalid_rules_missing_due_dates_and_other_workspaces() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let undated = create(
            &pool,
            DEFAULT_WORKSPACE,
            IssueFields {
                title: "Someday".into(),
                ..IssueFields::default()
            },
            None,
        )
        .await
        .unwrap()
        .summary
        .id;
        assert_eq!(
            set_rule(&pool, DEFAULT_WORKSPACE, &undated, rule("daily", 1)).await,
            Err(IssueError::RecurrenceNeedsDueDate)
        );
        for bad in [rule("hourly", 1), rule("daily", 0), rule("weekly", 100)] {
            assert_eq!(
                set_rule(&pool, DEFAULT_WORKSPACE, &undated, bad).await,
                Err(IssueError::InvalidRecurrence)
            );
        }
        let id = recurring(&pool, "Mine", "2026-11-16", ("daily", 1)).await;
        assert_eq!(
            set_rule(&pool, OTHER_WORKSPACE, &id, None).await,
            Err(IssueError::NotFound)
        );
        assert_eq!(
            recurrence_for(&pool, OTHER_WORKSPACE, &id).await,
            Err(IssueError::NotFound)
        );
        assert_eq!(
            set_status_on(&pool, DEFAULT_WORKSPACE, &id, "done", Some("16/11/2026")).await,
            Err(IssueError::InvalidDate)
        );
        assert_eq!(
            recurrence_for(&pool, DEFAULT_WORKSPACE, &undated).await,
            Ok(None)
        );
        // The schema keeps series and index together and in one workspace.
        assert!(
            sqlx::query("UPDATE issues SET occurrence_index = NULL WHERE id = ?")
                .bind(&id)
                .execute(&pool)
                .await
                .is_err()
        );
    });
}

#[test]
fn a_failed_next_occurrence_rolls_back_the_completion() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let id = recurring(&pool, "Fragile", "2026-11-16", ("daily", 1)).await;
        let (counter,): (i64,) = sqlx::query_as("SELECT last_number FROM issue_counters")
            .fetch_one(&pool)
            .await
            .unwrap();
        // Make creating the next occurrence fail.
        sqlx::query(
            "CREATE TEMP TRIGGER refuse BEFORE INSERT ON issues
             WHEN NEW.occurrence_index > 0 BEGIN SELECT RAISE(ABORT, 'refused'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            set_status_on(&pool, DEFAULT_WORKSPACE, &id, "done", None).await,
            Err(IssueError::StorageFailed)
        );
        let issue = crate::issues::get(&pool, DEFAULT_WORKSPACE, &id)
            .await
            .unwrap();
        assert_eq!(issue.summary.status, "todo");
        assert_eq!(issue.summary.completed_at, None);
        let (after,): (i64,) = sqlx::query_as("SELECT last_number FROM issue_counters")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(after, counter);
    });
}

#[test]
fn upgrading_keeps_issues_without_series() {
    tauri::async_runtime::block_on(async {
        let pool = memory_pool().await;
        migrator(10).await.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO issues (id, workspace_id, number, title, description, due_date)
             VALUES ('before', ?, 1, 'Before', '{\"type\":\"doc\"}', '2026-11-16')",
        )
        .bind(DEFAULT_WORKSPACE)
        .execute(&pool)
        .await
        .unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let issue = crate::issues::get(&pool, DEFAULT_WORKSPACE, "before")
            .await
            .unwrap();
        assert_eq!(issue.summary.recurrence_id, None);
        assert!(!issue.summary.recurring);
        set_status_on(
            &pool,
            DEFAULT_WORKSPACE,
            "before",
            "done",
            Some("2026-11-16"),
        )
        .await
        .unwrap();
    });
}
