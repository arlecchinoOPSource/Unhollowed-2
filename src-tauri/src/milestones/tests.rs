use super::*;
use crate::issues::{self, IssueError, IssueFields, IssueFilter, IssueQuery};
use crate::test_support::{
    add_workspace, memory_pool, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE,
    OTHER_WORKSPACE,
};

fn input(title: &str) -> MilestoneInput {
    MilestoneInput {
        title: title.into(),
        ..MilestoneInput::default()
    }
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

async fn issue(pool: &SqlitePool, workspace: &str, project: Option<&str>) -> String {
    issues::create(
        pool,
        workspace,
        IssueFields {
            title: "Task".into(),
            ..IssueFields::default()
        },
        project,
    )
    .await
    .unwrap()
    .summary
    .id
}

async fn counts(pool: &SqlitePool, id: &str) -> (i64, i64, i64) {
    let milestone = get(pool, DEFAULT_WORKSPACE, id).await.unwrap();
    (
        milestone.open_count,
        milestone.completed_count,
        milestone.canceled_count,
    )
}

#[test]
fn creates_edits_closes_and_reopens_workspace_and_project_milestones() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("milestones-lifecycle");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let launch = project(&pool, DEFAULT_WORKSPACE).await;

        let workspace_wide = create(
            &pool,
            DEFAULT_WORKSPACE,
            MilestoneInput {
                title: "  Q1 review ".into(),
                description: Some(" Look back ".into()),
                due_date: Some("2027-03-31".into()),
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(workspace_wide.title, "Q1 review");
        assert_eq!(workspace_wide.description.as_deref(), Some("Look back"));
        assert_eq!(workspace_wide.project_id, None);
        assert!(!workspace_wide.closed);
        assert_eq!(
            (workspace_wide.open_count, workspace_wide.completed_count),
            (0, 0)
        );

        let beta = create(&pool, DEFAULT_WORKSPACE, input("Beta"), Some(&launch))
            .await
            .unwrap();
        assert_eq!(beta.project_id.as_deref(), Some(launch.as_str()));

        let edited = update(
            &pool,
            DEFAULT_WORKSPACE,
            &beta.id,
            MilestoneInput {
                title: "Public beta".into(),
                description: None,
                due_date: Some("2027-01-15".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(edited.title, "Public beta");
        assert_eq!(edited.project_id, beta.project_id);

        let closed = set_closed(&pool, DEFAULT_WORKSPACE, &beta.id, true)
            .await
            .unwrap();
        assert!(closed.closed && closed.closed_at.is_some());
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(
            set_closed(&pool, DEFAULT_WORKSPACE, &beta.id, true)
                .await
                .unwrap(),
            closed
        );
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        // Open first, then by due date.
        let titles: Vec<_> = list(&pool, DEFAULT_WORKSPACE)
            .await
            .unwrap()
            .into_iter()
            .map(|milestone| milestone.title)
            .collect();
        assert_eq!(titles, ["Q1 review", "Public beta"]);
        let reopened = set_closed(&pool, DEFAULT_WORKSPACE, &beta.id, false)
            .await
            .unwrap();
        assert!(!reopened.closed && reopened.closed_at.is_none());
        // The scope is fixed once created.
        assert!(
            sqlx::query("UPDATE milestones SET project_id = NULL WHERE id = ?")
                .bind(&beta.id)
                .execute(&pool)
                .await
                .is_err()
        );
        pool.close().await;
    });
}

#[test]
fn rejects_invalid_input_and_other_workspaces() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let theirs = project(&pool, OTHER_WORKSPACE).await;
        let milestone = create(&pool, DEFAULT_WORKSPACE, input("Mine"), None)
            .await
            .unwrap();
        for (bad, error) in [
            (input(" "), MilestoneError::InvalidTitle),
            (input(&"x".repeat(201)), MilestoneError::InvalidTitle),
            (
                MilestoneInput {
                    description: Some("x".repeat(5001)),
                    ..input("T")
                },
                MilestoneError::InvalidDescription,
            ),
            (
                MilestoneInput {
                    due_date: Some("2027-02-29".into()),
                    ..input("T")
                },
                MilestoneError::InvalidDate,
            ),
        ] {
            assert_eq!(
                create(&pool, DEFAULT_WORKSPACE, bad.clone(), None).await,
                Err(error.clone())
            );
            assert_eq!(
                update(&pool, DEFAULT_WORKSPACE, &milestone.id, bad).await,
                Err(error)
            );
        }
        for foreign in [theirs.as_str(), "missing"] {
            assert_eq!(
                create(&pool, DEFAULT_WORKSPACE, input("T"), Some(foreign)).await,
                Err(MilestoneError::InvalidProject)
            );
        }
        assert_eq!(
            get(&pool, OTHER_WORKSPACE, &milestone.id).await,
            Err(MilestoneError::NotFound)
        );
        assert_eq!(
            update(&pool, OTHER_WORKSPACE, &milestone.id, input("Taken")).await,
            Err(MilestoneError::NotFound)
        );
        assert_eq!(
            set_closed(&pool, OTHER_WORKSPACE, &milestone.id, true).await,
            Err(MilestoneError::NotFound)
        );
        assert!(list(&pool, OTHER_WORKSPACE).await.unwrap().is_empty());
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, &milestone.id).await.unwrap(),
            milestone
        );
    });
}

#[test]
fn links_only_compatible_issues() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let launch = project(&pool, DEFAULT_WORKSPACE).await;
        let other_project = project(&pool, DEFAULT_WORKSPACE).await;
        let workspace_wide = create(&pool, DEFAULT_WORKSPACE, input("All"), None)
            .await
            .unwrap();
        let beta = create(&pool, DEFAULT_WORKSPACE, input("Beta"), Some(&launch))
            .await
            .unwrap();
        let foreign = create(&pool, OTHER_WORKSPACE, input("Theirs"), None)
            .await
            .unwrap();
        let inbox = issue(&pool, DEFAULT_WORKSPACE, None).await;
        let in_launch = issue(&pool, DEFAULT_WORKSPACE, Some(&launch)).await;
        let elsewhere = issue(&pool, DEFAULT_WORKSPACE, Some(&other_project)).await;

        // A workspace milestone accepts any issue in the workspace.
        for id in [&inbox, &in_launch, &elsewhere] {
            let linked =
                issues::set_milestone(&pool, DEFAULT_WORKSPACE, id, Some(&workspace_wide.id))
                    .await
                    .unwrap();
            assert_eq!(
                linked.summary.milestone_id.as_deref(),
                Some(workspace_wide.id.as_str())
            );
        }
        // A project milestone accepts only that project's issues.
        let linked = issues::set_milestone(&pool, DEFAULT_WORKSPACE, &in_launch, Some(&beta.id))
            .await
            .unwrap();
        assert_eq!(
            linked.summary.milestone_id.as_deref(),
            Some(beta.id.as_str())
        );
        for id in [&inbox, &elsewhere] {
            assert_eq!(
                issues::set_milestone(&pool, DEFAULT_WORKSPACE, id, Some(&beta.id)).await,
                Err(IssueError::InvalidMilestone)
            );
        }
        for milestone in [foreign.id.as_str(), "missing"] {
            assert_eq!(
                issues::set_milestone(&pool, DEFAULT_WORKSPACE, &inbox, Some(milestone)).await,
                Err(IssueError::InvalidMilestone)
            );
        }
        assert_eq!(
            issues::set_milestone(&pool, DEFAULT_WORKSPACE, "missing", Some(&beta.id)).await,
            Err(IssueError::NotFound)
        );
        assert_eq!(
            issues::set_milestone(&pool, DEFAULT_WORKSPACE, "missing", None).await,
            Err(IssueError::NotFound)
        );
        // Rejected requests left the earlier links alone.
        assert_eq!(
            issues::get(&pool, DEFAULT_WORKSPACE, &inbox)
                .await
                .unwrap()
                .summary
                .milestone_id
                .as_deref(),
            Some(workspace_wide.id.as_str())
        );

        // Closed milestones keep their issues but cannot gain new ones.
        set_closed(&pool, DEFAULT_WORKSPACE, &beta.id, true)
            .await
            .unwrap();
        let kept = issues::get(&pool, DEFAULT_WORKSPACE, &in_launch)
            .await
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(
            issues::set_milestone(&pool, DEFAULT_WORKSPACE, &in_launch, Some(&beta.id))
                .await
                .unwrap(),
            kept
        );
        let another = issue(&pool, DEFAULT_WORKSPACE, Some(&launch)).await;
        assert_eq!(
            issues::set_milestone(&pool, DEFAULT_WORKSPACE, &another, Some(&beta.id)).await,
            Err(IssueError::MilestoneClosed)
        );
        let cleared = issues::set_milestone(&pool, DEFAULT_WORKSPACE, &in_launch, None)
            .await
            .unwrap();
        assert_eq!(cleared.summary.milestone_id, None);
    });
}

#[test]
fn counts_follow_completion_cancellation_and_reassignment() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let first = create(&pool, DEFAULT_WORKSPACE, input("First"), None)
            .await
            .unwrap();
        let second = create(&pool, DEFAULT_WORKSPACE, input("Second"), None)
            .await
            .unwrap();
        // An empty milestone has no contributing issues.
        assert_eq!(counts(&pool, &first.id).await, (0, 0, 0));

        let mut ids = Vec::new();
        for _ in 0..4 {
            let id = issue(&pool, DEFAULT_WORKSPACE, None).await;
            issues::set_milestone(&pool, DEFAULT_WORKSPACE, &id, Some(&first.id))
                .await
                .unwrap();
            ids.push(id);
        }
        assert_eq!(counts(&pool, &first.id).await, (4, 0, 0));
        issues::set_status(&pool, DEFAULT_WORKSPACE, &ids[0], "done")
            .await
            .unwrap();
        issues::set_status(&pool, DEFAULT_WORKSPACE, &ids[1], "canceled")
            .await
            .unwrap();
        issues::set_status(&pool, DEFAULT_WORKSPACE, &ids[2], "blocked")
            .await
            .unwrap();
        assert_eq!(counts(&pool, &first.id).await, (2, 1, 1));

        issues::reopen(&pool, DEFAULT_WORKSPACE, &ids[0])
            .await
            .unwrap();
        assert_eq!(counts(&pool, &first.id).await, (3, 0, 1));

        issues::set_milestone(&pool, DEFAULT_WORKSPACE, &ids[3], Some(&second.id))
            .await
            .unwrap();
        assert_eq!(counts(&pool, &first.id).await, (2, 0, 1));
        assert_eq!(counts(&pool, &second.id).await, (1, 0, 0));

        // Closing a milestone does not change its issues or counts.
        let closed = set_closed(&pool, DEFAULT_WORKSPACE, &first.id, true)
            .await
            .unwrap();
        assert_eq!(
            (
                closed.open_count,
                closed.completed_count,
                closed.canceled_count
            ),
            (2, 0, 1)
        );
    });
}

#[test]
fn moving_an_issue_clears_a_milestone_from_another_project() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let launch = project(&pool, DEFAULT_WORKSPACE).await;
        let other = project(&pool, DEFAULT_WORKSPACE).await;
        let beta = create(&pool, DEFAULT_WORKSPACE, input("Beta"), Some(&launch))
            .await
            .unwrap();
        let shared = create(&pool, DEFAULT_WORKSPACE, input("Shared"), None)
            .await
            .unwrap();
        let project_issue = issue(&pool, DEFAULT_WORKSPACE, Some(&launch)).await;
        let workspace_issue = issue(&pool, DEFAULT_WORKSPACE, Some(&launch)).await;
        issues::set_milestone(&pool, DEFAULT_WORKSPACE, &project_issue, Some(&beta.id))
            .await
            .unwrap();
        issues::set_milestone(&pool, DEFAULT_WORKSPACE, &workspace_issue, Some(&shared.id))
            .await
            .unwrap();

        // Staying in the same project keeps the milestone.
        let same = issues::set_project(&pool, DEFAULT_WORKSPACE, &project_issue, Some(&launch))
            .await
            .unwrap();
        assert_eq!(same.summary.milestone_id.as_deref(), Some(beta.id.as_str()));

        for target in [Some(other.as_str()), None] {
            let moved = issues::set_project(&pool, DEFAULT_WORKSPACE, &workspace_issue, target)
                .await
                .unwrap();
            assert_eq!(
                moved.summary.milestone_id.as_deref(),
                Some(shared.id.as_str())
            );
        }
        let moved = issues::set_project(&pool, DEFAULT_WORKSPACE, &project_issue, Some(&other))
            .await
            .unwrap();
        assert_eq!(moved.summary.milestone_id, None);
        assert_eq!(counts(&pool, &beta.id).await, (0, 0, 0));
        // Moving back does not restore it.
        let back = issues::set_project(&pool, DEFAULT_WORKSPACE, &project_issue, Some(&launch))
            .await
            .unwrap();
        assert_eq!(back.summary.milestone_id, None);
    });
}

#[test]
fn the_schema_rejects_incompatible_links_and_protects_project_milestones() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let launch = project(&pool, DEFAULT_WORKSPACE).await;
        let other = project(&pool, DEFAULT_WORKSPACE).await;
        let beta = create(&pool, DEFAULT_WORKSPACE, input("Beta"), Some(&launch))
            .await
            .unwrap();
        let elsewhere = issue(&pool, DEFAULT_WORKSPACE, Some(&other)).await;
        let in_launch = issue(&pool, DEFAULT_WORKSPACE, Some(&launch)).await;

        assert!(
            sqlx::query("UPDATE issues SET milestone_id = ? WHERE id = ?")
                .bind(&beta.id)
                .bind(&elsewhere)
                .execute(&pool)
                .await
                .is_err()
        );
        issues::set_milestone(&pool, DEFAULT_WORKSPACE, &in_launch, Some(&beta.id))
            .await
            .unwrap();
        // Changing the project without clearing the milestone is refused.
        assert!(sqlx::query("UPDATE issues SET project_id = ? WHERE id = ?")
            .bind(&other)
            .bind(&in_launch)
            .execute(&pool)
            .await
            .is_err());
        // A project with milestones cannot be deleted silently.
        assert!(sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(&launch)
            .execute(&pool)
            .await
            .is_err());
        // Deleting a milestone clears it from its issues.
        sqlx::query("DELETE FROM milestones WHERE id = ?")
            .bind(&beta.id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            issues::get(&pool, DEFAULT_WORKSPACE, &in_launch)
                .await
                .unwrap()
                .summary
                .milestone_id,
            None
        );
    });
}

#[test]
fn filters_issues_by_milestone() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let first = create(&pool, DEFAULT_WORKSPACE, input("First"), None)
            .await
            .unwrap();
        let second = create(&pool, DEFAULT_WORKSPACE, input("Second"), None)
            .await
            .unwrap();
        let mut ids = Vec::new();
        for milestone in [Some(&first.id), Some(&second.id), None] {
            let id = issue(&pool, DEFAULT_WORKSPACE, None).await;
            if let Some(milestone) = milestone {
                issues::set_milestone(&pool, DEFAULT_WORKSPACE, &id, Some(milestone))
                    .await
                    .unwrap();
            }
            ids.push(id);
        }
        let run = |milestones: Vec<String>, none: bool| {
            let pool = pool.clone();
            async move {
                let mut found: Vec<_> = issues::query(
                    &pool,
                    DEFAULT_WORKSPACE,
                    IssueQuery {
                        filter: IssueFilter {
                            milestone_ids: milestones,
                            no_milestone: none,
                            ..IssueFilter::default()
                        },
                        ..IssueQuery::default()
                    },
                )
                .await
                .unwrap()
                .issues
                .into_iter()
                .map(|issue| issue.id)
                .collect();
                found.sort();
                found
            }
        };
        let sorted = |mut list: Vec<String>| {
            list.sort();
            list
        };
        assert_eq!(run(vec![first.id.clone()], false).await, [ids[0].clone()]);
        assert_eq!(run(vec![], true).await, [ids[2].clone()]);
        assert_eq!(
            run(vec![second.id.clone()], true).await,
            sorted(vec![ids[1].clone(), ids[2].clone()])
        );
        assert_eq!(run(vec![], false).await.len(), 3);
    });
}

#[test]
fn upgrading_keeps_issues_without_milestones() {
    tauri::async_runtime::block_on(async {
        let pool = memory_pool().await;
        migrator(7).await.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO issues (id, workspace_id, number, title, description)
             VALUES ('before', ?, 1, 'Before milestones', '{\"type\":\"doc\"}')",
        )
        .bind(DEFAULT_WORKSPACE)
        .execute(&pool)
        .await
        .unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let existing = issues::get(&pool, DEFAULT_WORKSPACE, "before")
            .await
            .unwrap();
        assert_eq!(existing.summary.title, "Before milestones");
        assert_eq!(existing.summary.milestone_id, None);
        assert!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().is_empty());
    });
}
