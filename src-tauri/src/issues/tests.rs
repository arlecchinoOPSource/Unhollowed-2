use super::*;
use crate::database::active_workspace;
use crate::test_support::{
    add_workspace, memory_pool, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE,
    OTHER_WORKSPACE,
};

const DESCRIPTION: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Steps"}]}]}"#;

fn fields(title: &str) -> IssueFields {
    IssueFields {
        title: title.into(),
        ..IssueFields::default()
    }
}

async fn project(pool: &SqlitePool, workspace: &str, name: &str) -> String {
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO projects (id, workspace_id, name) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(workspace)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    id
}

#[test]
fn projectless_and_project_issues_persist_after_reopening() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("issues-reopen");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let project_id = project(&pool, DEFAULT_WORKSPACE, "Launch").await;

        let inbox = create(&pool, DEFAULT_WORKSPACE, fields("  Draft outline  "), None)
            .await
            .unwrap();
        assert!(Uuid::parse_str(&inbox.summary.id).is_ok());
        assert_eq!(inbox.summary.number, 1);
        assert_eq!(inbox.summary.title, "Draft outline");
        assert_eq!(inbox.summary.project_id, None);
        assert_eq!(inbox.summary.status, "todo");
        assert_eq!(inbox.summary.priority, "none");
        assert!(!inbox.summary.closed);
        assert_eq!(inbox.summary.completed_at, None);
        assert_eq!(inbox.description, EMPTY_CONTENT);
        assert_eq!(inbox.summary.created_at, inbox.summary.updated_at);

        let planned = create(
            &pool,
            DEFAULT_WORKSPACE,
            IssueFields {
                title: "Book venue".into(),
                description: Some(DESCRIPTION.into()),
                priority: Some("high".into()),
                start_date: Some("2028-02-28".into()),
                due_date: Some("2028-02-29".into()),
            },
            Some(&project_id),
        )
        .await
        .unwrap();
        assert_eq!(planned.summary.number, 2);
        assert_eq!(planned.summary.project_id.as_deref(), Some(&*project_id));
        assert_eq!(planned.description, DESCRIPTION);
        assert_eq!(planned.summary.priority, "high");
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, &inbox.summary.id)
                .await
                .unwrap(),
            inbox
        );
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, &planned.summary.id)
                .await
                .unwrap(),
            planned
        );
        assert_eq!(list(&pool, DEFAULT_WORKSPACE, None).await.unwrap().len(), 2);
        let in_project = list(&pool, DEFAULT_WORKSPACE, Some(&project_id))
            .await
            .unwrap();
        assert_eq!(in_project, vec![planned.summary]);
        pool.close().await;
    });
}

#[test]
fn rejects_malformed_input_without_using_a_number() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let invalid = [
            (fields("   "), IssueError::InvalidTitle),
            (fields(&"x".repeat(201)), IssueError::InvalidTitle),
            (fields("Nul\0"), IssueError::InvalidTitle),
            (
                IssueFields {
                    description: Some("not json".into()),
                    ..fields("T")
                },
                IssueError::InvalidDescription,
            ),
            (
                IssueFields {
                    description: Some(r#"{"type":"paragraph"}"#.into()),
                    ..fields("T")
                },
                IssueError::InvalidDescription,
            ),
            (
                IssueFields {
                    priority: Some("critical".into()),
                    ..fields("T")
                },
                IssueError::InvalidPriority,
            ),
            (
                IssueFields {
                    due_date: Some("2027-02-29".into()),
                    ..fields("T")
                },
                IssueError::InvalidDate,
            ),
            (
                IssueFields {
                    start_date: Some("2026-12-02".into()),
                    due_date: Some("2026-12-01".into()),
                    ..fields("T")
                },
                IssueError::InvalidDateRange,
            ),
        ];
        for (input, error) in invalid {
            assert_eq!(
                create(&pool, DEFAULT_WORKSPACE, input, None).await,
                Err(error)
            );
        }
        assert_eq!(
            create(&pool, DEFAULT_WORKSPACE, fields("Valid"), None)
                .await
                .unwrap()
                .summary
                .number,
            1
        );
    });
}

#[test]
fn rejects_projects_from_other_workspaces_and_rolls_back_the_number() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let foreign = project(&pool, OTHER_WORKSPACE, "Theirs").await;

        // The project check runs after the counter update, so this proves the
        // transaction rolls the counter back.
        for project_id in [foreign.as_str(), "missing"] {
            assert_eq!(
                create(&pool, DEFAULT_WORKSPACE, fields("Mine"), Some(project_id)).await,
                Err(IssueError::InvalidProject)
            );
        }
        assert!(list(&pool, DEFAULT_WORKSPACE, None)
            .await
            .unwrap()
            .is_empty());
        let created = create(&pool, DEFAULT_WORKSPACE, fields("Mine"), None)
            .await
            .unwrap();
        assert_eq!(created.summary.number, 1);
    });
}

#[test]
fn scopes_reads_to_the_owning_workspace_and_numbers_each_workspace_separately() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let mine = create(&pool, DEFAULT_WORKSPACE, fields("Mine"), None)
            .await
            .unwrap();
        let theirs = create(&pool, OTHER_WORKSPACE, fields("Theirs"), None)
            .await
            .unwrap();
        assert_eq!(theirs.summary.number, 1);
        assert_eq!(
            get(&pool, OTHER_WORKSPACE, &mine.summary.id).await,
            Err(IssueError::NotFound)
        );
        assert_eq!(
            list(&pool, OTHER_WORKSPACE, None).await.unwrap(),
            vec![theirs.summary]
        );
        assert_eq!(
            list(&pool, DEFAULT_WORKSPACE, None).await.unwrap(),
            vec![mine.summary]
        );
    });
}

#[test]
fn concurrent_creates_receive_distinct_increasing_numbers() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("issues-concurrent");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();

        let tasks: Vec<_> = (0..24)
            .map(|index| {
                let pool = pool.clone();
                tauri::async_runtime::spawn(async move {
                    create(
                        &pool,
                        DEFAULT_WORKSPACE,
                        fields(&format!("Task {index}")),
                        None,
                    )
                    .await
                    .unwrap()
                    .summary
                    .number
                })
            })
            .collect();
        let mut numbers = Vec::new();
        for task in tasks {
            numbers.push(task.await.unwrap());
        }
        numbers.sort_unstable();
        assert_eq!(numbers, (1..=24).collect::<Vec<i64>>());
        pool.close().await;
    });
}

#[test]
fn identity_survives_project_deletion_and_numbers_are_never_reused() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project_id = project(&pool, DEFAULT_WORKSPACE, "Temporary").await;
        let kept = create(&pool, DEFAULT_WORKSPACE, fields("Kept"), Some(&project_id))
            .await
            .unwrap();
        let removed = create(&pool, DEFAULT_WORKSPACE, fields("Removed"), None)
            .await
            .unwrap();

        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(&project_id)
            .execute(&pool)
            .await
            .unwrap();
        let moved = get(&pool, DEFAULT_WORKSPACE, &kept.summary.id)
            .await
            .unwrap();
        assert_eq!(moved.summary.project_id, None);
        assert_eq!(moved.summary.number, kept.summary.number);

        sqlx::query("DELETE FROM issues WHERE id = ?")
            .bind(&removed.summary.id)
            .execute(&pool)
            .await
            .unwrap();
        let next = create(&pool, DEFAULT_WORKSPACE, fields("Next"), None)
            .await
            .unwrap();
        assert_eq!(next.summary.number, 3);
    });
}

#[test]
fn the_schema_rejects_malformed_and_cross_workspace_rows() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let mine = project(&pool, DEFAULT_WORKSPACE, "Mine").await;
        let foreign = project(&pool, OTHER_WORKSPACE, "Theirs").await;
        let issue = create(&pool, DEFAULT_WORKSPACE, fields("Owned"), Some(&mine))
            .await
            .unwrap();

        let insert = |number: i64, project: Option<&str>, column: &str, value: &str| {
            let sql = format!(
                "INSERT INTO issues (id, workspace_id, number, project_id, title, description, {column})
                 VALUES (?, ?, ?, ?, 'T', ?, ?)"
            );
            let pool = pool.clone();
            let project = project.map(str::to_owned);
            let value = value.to_owned();
            async move {
                sqlx::query(&sql)
                    .bind(Uuid::new_v4().to_string())
                    .bind(DEFAULT_WORKSPACE)
                    .bind(number)
                    .bind(project)
                    .bind(EMPTY_CONTENT)
                    .bind(value)
                    .execute(&pool)
                    .await
            }
        };
        // Cross-workspace project, duplicate number, and invalid values.
        assert!(insert(10, Some(&foreign), "priority", "low").await.is_err());
        assert!(insert(1, None, "priority", "low").await.is_err());
        assert!(insert(11, None, "status", "closed").await.is_err());
        assert!(insert(12, None, "priority", "critical").await.is_err());
        assert!(insert(13, None, "completed_at", "2026-01-01T00:00:00Z")
            .await
            .is_err());
        assert!(insert(0, None, "priority", "low").await.is_err());
        assert!(
            sqlx::query("UPDATE issues SET description = 'not json' WHERE id = ?")
                .bind(&issue.summary.id)
                .execute(&pool)
                .await
                .is_err()
        );
        assert!(sqlx::query("UPDATE issues SET project_id = ? WHERE id = ?")
            .bind(&foreign)
            .bind(&issue.summary.id)
            .execute(&pool)
            .await
            .is_err());
        assert!(
            sqlx::query("UPDATE issues SET workspace_id = ? WHERE id = ?")
                .bind(OTHER_WORKSPACE)
                .bind(&issue.summary.id)
                .execute(&pool)
                .await
                .is_err()
        );

        // Closed follows status without being written directly.
        for (status, closed) in [("done", true), ("canceled", true), ("blocked", false)] {
            let (value,): (bool,) =
                sqlx::query_as("UPDATE issues SET status = ? WHERE id = ? RETURNING closed")
                    .bind(status)
                    .bind(&issue.summary.id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(value, closed);
        }
        assert!(sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .is_err());
    });
}

#[test]
fn upgrading_from_the_projects_schema_keeps_existing_records() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("issues-upgrade");
        let pool = database.open().await;
        migrator(4).await.run(&pool).await.unwrap();
        let workspace = active_workspace(&pool).await.unwrap();
        let document = crate::documents::create(&pool, &workspace.id, Some("Existing draft"))
            .await
            .unwrap();
        let project_id = project(&pool, &workspace.id, "Existing project").await;
        let project = crate::projects::get(&pool, &workspace.id, &project_id)
            .await
            .unwrap();
        pool.close().await;

        let pool = database.open().await;
        let migrations = migrator(i64::MAX).await;
        migrations.run(&pool).await.unwrap();
        migrations.run(&pool).await.unwrap();
        assert_eq!(active_workspace(&pool).await.unwrap(), workspace);
        assert_eq!(
            crate::documents::get(&pool, &workspace.id, &document.id)
                .await
                .unwrap(),
            document
        );
        assert_eq!(
            crate::projects::get(&pool, &workspace.id, &project_id)
                .await
                .unwrap(),
            project
        );
        assert!(list(&pool, &workspace.id, None).await.unwrap().is_empty());
        let issue = create(&pool, &workspace.id, fields("First"), Some(&project_id))
            .await
            .unwrap();
        assert_eq!(issue.summary.number, 1);
        pool.close().await;
    });
}

#[test]
fn an_unmigrated_database_reports_a_storage_error() {
    tauri::async_runtime::block_on(async {
        let pool = memory_pool().await;
        assert_eq!(
            list(&pool, DEFAULT_WORKSPACE, None).await,
            Err(IssueError::StorageFailed)
        );
    });
}

fn pause() {
    // Timestamps have millisecond precision. Waiting proves a retry kept them.
    std::thread::sleep(std::time::Duration::from_millis(5));
}

#[test]
fn lifecycle_transitions_keep_identity_and_track_completion_once() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let issue = create(&pool, DEFAULT_WORKSPACE, fields("Ship"), None)
            .await
            .unwrap();
        let id = &issue.summary.id;
        let same_identity = |changed: &Issue| {
            assert_eq!(changed.summary.id, issue.summary.id);
            assert_eq!(changed.summary.number, issue.summary.number);
            assert_eq!(changed.summary.created_at, issue.summary.created_at);
        };

        let done = set_status(&pool, DEFAULT_WORKSPACE, id, "done")
            .await
            .unwrap();
        same_identity(&done);
        assert_eq!(done.summary.status, "done");
        assert!(done.summary.closed);
        assert!(done.summary.completed_at.is_some());
        pause();
        let retried = set_status(&pool, DEFAULT_WORKSPACE, id, "done")
            .await
            .unwrap();
        assert_eq!(retried, done);

        let canceled = set_status(&pool, DEFAULT_WORKSPACE, id, "canceled")
            .await
            .unwrap();
        same_identity(&canceled);
        assert!(canceled.summary.closed);
        assert_eq!(canceled.summary.completed_at, None);

        let reopened = reopen(&pool, DEFAULT_WORKSPACE, id).await.unwrap();
        same_identity(&reopened);
        assert_eq!(reopened.summary.status, "todo");
        assert!(!reopened.summary.closed);
        pause();
        assert_eq!(
            reopen(&pool, DEFAULT_WORKSPACE, id).await.unwrap(),
            reopened
        );

        // Reopening an open issue keeps its progress.
        let started = set_status(&pool, DEFAULT_WORKSPACE, id, "in_progress")
            .await
            .unwrap();
        assert_eq!(
            reopen(&pool, DEFAULT_WORKSPACE, id)
                .await
                .unwrap()
                .summary
                .status,
            "in_progress"
        );
        assert_eq!(started.summary.completed_at, None);
        let blocked = set_status(&pool, DEFAULT_WORKSPACE, id, "blocked")
            .await
            .unwrap();
        assert!(!blocked.summary.closed);

        pause();
        let completed_again = set_status(&pool, DEFAULT_WORKSPACE, id, "done")
            .await
            .unwrap();
        assert!(completed_again.summary.completed_at > done.summary.completed_at);
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, id).await.unwrap(),
            completed_again
        );
    });
}

#[test]
fn moves_between_owned_projects_and_back_to_the_inbox() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let first = project(&pool, DEFAULT_WORKSPACE, "First").await;
        let second = project(&pool, DEFAULT_WORKSPACE, "Second").await;
        let foreign = project(&pool, OTHER_WORKSPACE, "Theirs").await;
        let issue = create(&pool, DEFAULT_WORKSPACE, fields("Wander"), None)
            .await
            .unwrap();
        let id = &issue.summary.id;

        for target in [Some(first.as_str()), Some(second.as_str()), None] {
            let moved = set_project(&pool, DEFAULT_WORKSPACE, id, target)
                .await
                .unwrap();
            assert_eq!(moved.summary.project_id.as_deref(), target);
            assert_eq!(moved.summary.number, issue.summary.number);
        }
        let inbox = get(&pool, DEFAULT_WORKSPACE, id).await.unwrap();
        pause();
        assert_eq!(
            set_project(&pool, DEFAULT_WORKSPACE, id, None)
                .await
                .unwrap(),
            inbox
        );
        for target in [foreign.as_str(), "missing"] {
            assert_eq!(
                set_project(&pool, DEFAULT_WORKSPACE, id, Some(target)).await,
                Err(IssueError::InvalidProject)
            );
        }
        assert_eq!(get(&pool, DEFAULT_WORKSPACE, id).await.unwrap(), inbox);
    });
}

#[test]
fn edits_persist_and_invalid_edits_change_nothing() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("issues-edit");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let issue = create(&pool, DEFAULT_WORKSPACE, fields("Original"), None)
            .await
            .unwrap();
        let id = &issue.summary.id;
        let done = set_status(&pool, DEFAULT_WORKSPACE, id, "done")
            .await
            .unwrap();

        let edited = update(
            &pool,
            DEFAULT_WORKSPACE,
            id,
            IssueFields {
                title: " Revised ".into(),
                description: Some(DESCRIPTION.into()),
                priority: Some("urgent".into()),
                start_date: None,
                due_date: Some("2026-12-31".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(edited.summary.title, "Revised");
        assert_eq!(edited.description, DESCRIPTION);
        assert_eq!(edited.summary.priority, "urgent");
        assert_eq!(edited.summary.due_date.as_deref(), Some("2026-12-31"));
        // Editing fields leaves the lifecycle alone.
        assert_eq!(edited.summary.status, "done");
        assert_eq!(edited.summary.completed_at, done.summary.completed_at);

        let invalid = [
            (fields(""), IssueError::InvalidTitle),
            (
                IssueFields {
                    description: Some("[]".into()),
                    ..fields("T")
                },
                IssueError::InvalidDescription,
            ),
            (
                IssueFields {
                    start_date: Some("2027-01-02".into()),
                    due_date: Some("2027-01-01".into()),
                    ..fields("T")
                },
                IssueError::InvalidDateRange,
            ),
        ];
        for (input, error) in invalid {
            assert_eq!(
                update(&pool, DEFAULT_WORKSPACE, id, input).await,
                Err(error)
            );
        }
        assert_eq!(
            set_status(&pool, DEFAULT_WORKSPACE, id, "closed").await,
            Err(IssueError::InvalidStatus)
        );
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(get(&pool, DEFAULT_WORKSPACE, id).await.unwrap(), edited);
        pool.close().await;
    });
}

#[test]
fn every_change_rejects_missing_and_cross_workspace_issues() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let theirs = project(&pool, OTHER_WORKSPACE, "Theirs").await;
        let issue = create(&pool, DEFAULT_WORKSPACE, fields("Private"), None)
            .await
            .unwrap();

        for (workspace, id) in [
            (OTHER_WORKSPACE, issue.summary.id.as_str()),
            (DEFAULT_WORKSPACE, "missing"),
        ] {
            assert_eq!(get(&pool, workspace, id).await, Err(IssueError::NotFound));
            assert_eq!(
                update(&pool, workspace, id, fields("Taken")).await,
                Err(IssueError::NotFound)
            );
            assert_eq!(
                set_status(&pool, workspace, id, "done").await,
                Err(IssueError::NotFound)
            );
            assert_eq!(
                reopen(&pool, workspace, id).await,
                Err(IssueError::NotFound)
            );
            assert_eq!(
                set_project(&pool, workspace, id, None).await,
                Err(IssueError::NotFound)
            );
        }
        // A project in the other workspace cannot be used to reach the issue.
        assert_eq!(
            set_project(&pool, OTHER_WORKSPACE, &issue.summary.id, Some(&theirs)).await,
            Err(IssueError::NotFound)
        );
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, &issue.summary.id)
                .await
                .unwrap(),
            issue
        );
    });
}
