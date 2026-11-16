use super::*;
use crate::issues::{create, set_project, set_status, update, IssueFields};
use crate::test_support::{
    add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};
use std::collections::HashSet;
use uuid::Uuid;

const RICH: &str = r#"{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Venue"}]},{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Confirm"},{"type":"text","text":" the Café"},{"type":"hardBreak"},{"type":"text","text":"by Friday"}]}]}"#;

struct Seed<'a> {
    title: &'a str,
    priority: &'a str,
    due: Option<&'a str>,
    status: &'a str,
    project: Option<&'a str>,
}

impl Default for Seed<'_> {
    fn default() -> Self {
        Seed {
            title: "Task",
            priority: "none",
            due: None,
            status: "todo",
            project: None,
        }
    }
}

async fn seed(pool: &SqlitePool, workspace: &str, seed: Seed<'_>) -> IssueSummary {
    let issue = create(
        pool,
        workspace,
        IssueFields {
            title: seed.title.into(),
            priority: Some(seed.priority.into()),
            due_date: seed.due.map(Into::into),
            ..IssueFields::default()
        },
        seed.project,
    )
    .await
    .unwrap();
    set_status(pool, workspace, &issue.summary.id, seed.status)
        .await
        .unwrap()
        .summary
}

async fn project(pool: &SqlitePool, workspace: &str) -> String {
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO projects (id, workspace_id, name) VALUES (?, ?, 'P')")
        .bind(&id)
        .bind(workspace)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn titles(pool: &SqlitePool, query: IssueQuery) -> Vec<String> {
    super::query(pool, DEFAULT_WORKSPACE, query)
        .await
        .unwrap()
        .issues
        .into_iter()
        .map(|issue| issue.title)
        .collect()
}

fn text(value: &str) -> IssueQuery {
    IssueQuery {
        filter: IssueFilter {
            text: Some(value.into()),
            ..IssueFilter::default()
        },
        sort: Some("title".into()),
        ..IssueQuery::default()
    }
}

#[test]
fn search_text_reads_rich_descriptions_with_unicode_case_folding() {
    assert_eq!(
        search_text("ÉTUDE Plan", RICH),
        "étude plan\nvenue\nconfirm the café\nby friday\n"
    );
    assert_eq!(search_text("Only title", "not json"), "only title\n");
}

#[test]
fn matches_literal_text_in_titles_and_descriptions() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for title in ["100% done", "a_b", "abc", "Étude"] {
            seed(
                &pool,
                DEFAULT_WORKSPACE,
                Seed {
                    title,
                    ..Seed::default()
                },
            )
            .await;
        }
        let described = seed(&pool, DEFAULT_WORKSPACE, Seed::default()).await;
        update(
            &pool,
            DEFAULT_WORKSPACE,
            &described.id,
            IssueFields {
                title: "Book space".into(),
                description: Some(RICH.into()),
                ..IssueFields::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(titles(&pool, text("%")).await, ["100% done"]);
        assert_eq!(titles(&pool, text("_")).await, ["a_b"]);
        assert_eq!(titles(&pool, text("  ÉTUDE ")).await, ["Étude"]);
        assert_eq!(titles(&pool, text("the café")).await, ["Book space"]);
        assert_eq!(titles(&pool, text("CONFIRM")).await, ["Book space"]);
        assert!(titles(&pool, text("café by")).await.is_empty());
        assert!(titles(&pool, text("missing words")).await.is_empty());
        // An empty search matches everything.
        assert_eq!(titles(&pool, text("   ")).await.len(), 5);

        // Renaming updates the searchable text.
        update(
            &pool,
            DEFAULT_WORKSPACE,
            &described.id,
            IssueFields {
                title: "Renamed".into(),
                ..IssueFields::default()
            },
        )
        .await
        .unwrap();
        assert!(titles(&pool, text("café")).await.is_empty());
        assert_eq!(titles(&pool, text("renamed")).await, ["Renamed"]);
    });
}

#[test]
fn combines_filters_and_reports_open_and_closed_counts() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let launch = project(&pool, DEFAULT_WORKSPACE).await;
        let other = project(&pool, DEFAULT_WORKSPACE).await;
        let seeds = [
            ("A", "high", "todo", Some(launch.as_str())),
            ("B", "high", "done", Some(launch.as_str())),
            ("C", "low", "in_progress", Some(launch.as_str())),
            ("D", "high", "blocked", None),
            ("E", "urgent", "canceled", Some(other.as_str())),
        ];
        for (title, priority, status, project) in seeds {
            seed(
                &pool,
                DEFAULT_WORKSPACE,
                Seed {
                    title,
                    priority,
                    status,
                    project,
                    ..Seed::default()
                },
            )
            .await;
        }
        let run = |filter: IssueFilter| {
            let pool = pool.clone();
            async move {
                let page = super::query(
                    &pool,
                    DEFAULT_WORKSPACE,
                    IssueQuery {
                        filter,
                        sort: Some("title".into()),
                        ..IssueQuery::default()
                    },
                )
                .await
                .unwrap();
                let names: Vec<_> = page
                    .issues
                    .iter()
                    .map(|issue| issue.title.clone())
                    .collect();
                (names, page.total, page.open, page.closed)
            }
        };

        let high_in_launch = IssueFilter {
            priorities: vec!["high".into()],
            project_ids: vec![launch.clone()],
            ..IssueFilter::default()
        };
        assert_eq!(
            run(high_in_launch.clone()).await,
            (vec!["A".into(), "B".into()], 2, 1, 1)
        );
        assert_eq!(
            run(IssueFilter {
                state: Some("open".into()),
                ..high_in_launch.clone()
            })
            .await,
            (vec!["A".into()], 1, 1, 1)
        );
        assert_eq!(
            run(IssueFilter {
                inbox: true,
                ..high_in_launch
            })
            .await
            .0,
            ["A", "B", "D"]
        );
        assert_eq!(
            run(IssueFilter {
                inbox: true,
                ..IssueFilter::default()
            })
            .await
            .0,
            ["D"]
        );
        assert_eq!(
            run(IssueFilter {
                statuses: vec!["blocked".into(), "in_progress".into()],
                ..IssueFilter::default()
            })
            .await
            .0,
            ["C", "D"]
        );
        assert_eq!(
            run(IssueFilter {
                state: Some("closed".into()),
                project_ids: vec![other.clone(), launch.clone()],
                ..IssueFilter::default()
            })
            .await,
            (vec!["B".into(), "E".into()], 2, 2, 2)
        );
        // No matches is an empty page, not an error.
        assert_eq!(
            run(IssueFilter {
                statuses: vec!["done".into()],
                priorities: vec!["low".into()],
                ..IssueFilter::default()
            })
            .await,
            (vec![], 0, 0, 0)
        );
        assert_eq!(
            run(IssueFilter {
                project_ids: vec!["unknown".into()],
                ..IssueFilter::default()
            })
            .await
            .1,
            0
        );

        // Moving an issue changes which project filter matches it.
        let page = super::query(&pool, DEFAULT_WORKSPACE, text("d"))
            .await
            .unwrap();
        set_project(&pool, DEFAULT_WORKSPACE, &page.issues[0].id, Some(&other))
            .await
            .unwrap();
        assert_eq!(
            run(IssueFilter {
                project_ids: vec![other],
                ..IssueFilter::default()
            })
            .await
            .0,
            ["D", "E"]
        );
    });
}

#[test]
fn due_date_filters_and_sorting_handle_undated_issues() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for (title, due) in [
            ("Early", Some("2026-11-01")),
            ("Middle", Some("2026-11-15")),
            ("Late", Some("2026-12-01")),
            ("Someday", None),
            ("Whenever", None),
        ] {
            seed(
                &pool,
                DEFAULT_WORKSPACE,
                Seed {
                    title,
                    due,
                    ..Seed::default()
                },
            )
            .await;
        }
        let due = |after: Option<&str>, before: Option<&str>, undated: Option<&str>| IssueQuery {
            filter: IssueFilter {
                due_after: after.map(Into::into),
                due_before: before.map(Into::into),
                undated: undated.map(Into::into),
                ..IssueFilter::default()
            },
            sort: Some("due".into()),
            ..IssueQuery::default()
        };

        assert_eq!(
            titles(&pool, due(Some("2026-11-15"), Some("2026-12-01"), None)).await,
            ["Middle", "Late", "Someday", "Whenever"]
        );
        assert_eq!(
            titles(
                &pool,
                due(Some("2026-11-15"), Some("2026-11-15"), Some("exclude"))
            )
            .await,
            ["Middle"]
        );
        assert_eq!(
            titles(&pool, due(None, Some("2026-11-14"), Some("exclude"))).await,
            ["Early"]
        );
        assert_eq!(
            titles(&pool, due(None, None, Some("exclude"))).await,
            ["Early", "Middle", "Late"]
        );
        assert_eq!(
            titles(&pool, due(None, None, Some("only"))).await,
            ["Someday", "Whenever"]
        );

        // Undated issues come last in both directions, ordered by number.
        assert_eq!(
            titles(&pool, due(None, None, None)).await,
            ["Early", "Middle", "Late", "Someday", "Whenever"]
        );
        let mut descending = due(None, None, None);
        descending.direction = Some("desc".into());
        assert_eq!(
            titles(&pool, descending).await,
            ["Late", "Middle", "Early", "Whenever", "Someday"]
        );
    });
}

#[test]
fn hundreds_of_issues_page_in_a_stable_total_order() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let priorities = ["none", "low", "medium", "high", "urgent"];
        for index in 0..300 {
            seed(
                &pool,
                DEFAULT_WORKSPACE,
                Seed {
                    // Many equal titles, priorities, and dates force tie-breaks.
                    title: ["Alpha", "beta", "Gamma"][index % 3],
                    priority: priorities[index % 5],
                    due: [Some("2026-12-01"), None, Some("2026-11-20")][index % 3],
                    status: if index % 4 == 0 { "done" } else { "todo" },
                    ..Seed::default()
                },
            )
            .await;
        }

        for sort in ["updated", "created", "priority", "title", "due"] {
            for direction in ["asc", "desc"] {
                let mut seen = Vec::new();
                let mut offset = 0;
                loop {
                    let page = super::query(
                        &pool,
                        DEFAULT_WORKSPACE,
                        IssueQuery {
                            sort: Some(sort.into()),
                            direction: Some(direction.into()),
                            limit: Some(37),
                            offset,
                            ..IssueQuery::default()
                        },
                    )
                    .await
                    .unwrap();
                    assert_eq!(page.total, 300);
                    assert_eq!((page.open, page.closed), (225, 75));
                    if page.issues.is_empty() {
                        break;
                    }
                    offset += 37;
                    seen.extend(page.issues);
                }
                let ids: HashSet<_> = seen.iter().map(|issue| &issue.id).collect();
                assert_eq!(
                    ids.len(),
                    300,
                    "{sort} {direction} repeated or skipped issues"
                );

                let rank = |priority: &str| priorities.iter().position(|p| *p == priority);
                for pair in seen.windows(2) {
                    let (a, b) = (&pair[0], &pair[1]);
                    let ordering = match sort {
                        "priority" => rank(&a.priority).cmp(&rank(&b.priority)),
                        "title" => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
                        "due" => match (&a.due_date, &b.due_date) {
                            (None, None) => std::cmp::Ordering::Equal,
                            // Undated issues stay last whatever the direction.
                            (None, Some(_)) | (Some(_), None) => {
                                assert!(b.due_date.is_none(), "undated issue before a dated one");
                                continue;
                            }
                            (Some(x), Some(y)) => x.cmp(y),
                        },
                        "created" => a.created_at.cmp(&b.created_at),
                        _ => a.updated_at.cmp(&b.updated_at),
                    }
                    .then(a.number.cmp(&b.number));
                    let expected = if direction == "asc" {
                        std::cmp::Ordering::Less
                    } else {
                        std::cmp::Ordering::Greater
                    };
                    assert_eq!(
                        ordering, expected,
                        "{sort} {direction}: {} then {}",
                        a.number, b.number
                    );
                }
            }
        }
        // Results are bounded.
        let page = super::query(&pool, DEFAULT_WORKSPACE, IssueQuery::default())
            .await
            .unwrap();
        assert_eq!(page.issues.len(), DEFAULT_LIMIT as usize);
    });
}

#[test]
fn never_returns_or_counts_another_workspaces_issues() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let theirs = project(&pool, OTHER_WORKSPACE).await;
        seed(
            &pool,
            OTHER_WORKSPACE,
            Seed {
                title: "Shared words",
                project: Some(&theirs),
                ..Seed::default()
            },
        )
        .await;
        seed(
            &pool,
            DEFAULT_WORKSPACE,
            Seed {
                title: "Shared words",
                ..Seed::default()
            },
        )
        .await;

        let page = super::query(&pool, DEFAULT_WORKSPACE, text("shared"))
            .await
            .unwrap();
        assert_eq!((page.total, page.issues.len()), (1, 1));
        let page = super::query(
            &pool,
            DEFAULT_WORKSPACE,
            IssueQuery {
                filter: IssueFilter {
                    project_ids: vec![theirs],
                    ..IssueFilter::default()
                },
                ..IssueQuery::default()
            },
        )
        .await
        .unwrap();
        assert_eq!((page.total, page.open), (0, 0));
    });
}

#[test]
fn rejects_unsupported_filters() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let invalid = [
            IssueQuery {
                sort: Some("rank".into()),
                ..IssueQuery::default()
            },
            IssueQuery {
                direction: Some("up".into()),
                ..IssueQuery::default()
            },
            IssueQuery {
                limit: Some(0),
                ..IssueQuery::default()
            },
            IssueQuery {
                limit: Some(MAX_LIMIT + 1),
                ..IssueQuery::default()
            },
        ];
        let filters = [
            IssueFilter {
                state: Some("archived".into()),
                ..IssueFilter::default()
            },
            IssueFilter {
                statuses: vec!["closed".into()],
                ..IssueFilter::default()
            },
            IssueFilter {
                priorities: vec!["critical".into()],
                ..IssueFilter::default()
            },
            IssueFilter {
                due_after: Some("2026-02-30".into()),
                ..IssueFilter::default()
            },
            IssueFilter {
                due_after: Some("2026-12-02".into()),
                due_before: Some("2026-12-01".into()),
                ..IssueFilter::default()
            },
            IssueFilter {
                due_before: Some("2026-12-01".into()),
                undated: Some("only".into()),
                ..IssueFilter::default()
            },
            IssueFilter {
                undated: Some("maybe".into()),
                ..IssueFilter::default()
            },
            IssueFilter {
                text: Some("x".repeat(201)),
                ..IssueFilter::default()
            },
        ];
        for query in invalid
            .into_iter()
            .chain(filters.into_iter().map(|filter| IssueQuery {
                filter,
                ..IssueQuery::default()
            }))
        {
            assert_eq!(
                super::query(&pool, DEFAULT_WORKSPACE, query).await,
                Err(IssueError::InvalidFilter)
            );
        }
    });
}

#[test]
fn indexes_issues_saved_before_the_search_migration() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("issues-search-upgrade");
        let pool = database.open().await;
        migrator(5).await.run(&pool).await.unwrap();
        // Migration 5 had no search_text column, so insert as that schema did.
        sqlx::query(
            "INSERT INTO issues (id, workspace_id, number, title, description)
             VALUES ('legacy', ?, 1, 'ÉCOLE visit', ?)",
        )
        .bind(DEFAULT_WORKSPACE)
        .bind(RICH)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO issue_counters (workspace_id, last_number) VALUES (?, 1)")
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .unwrap();
        let (before,): (String,) = sqlx::query_as("SELECT updated_at FROM issues")
            .fetch_one(&pool)
            .await
            .unwrap();
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(titles(&pool, text("école")).await, ["ÉCOLE visit"]);
        assert_eq!(titles(&pool, text("the café")).await, ["ÉCOLE visit"]);
        let (after, indexed): (String, String) =
            sqlx::query_as("SELECT updated_at, search_text FROM issues")
                .fetch_one(&pool)
                .await
                .unwrap();
        // Indexing is not an edit.
        assert_eq!(after, before);
        assert_eq!(indexed, search_text("ÉCOLE visit", RICH));
        let next = seed(&pool, DEFAULT_WORKSPACE, Seed::default()).await;
        assert_eq!(next.number, 2);
        pool.close().await;
    });
}
