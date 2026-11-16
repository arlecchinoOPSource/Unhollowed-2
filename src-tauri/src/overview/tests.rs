use super::*;
use crate::issues::{create, set_status, IssueFields};
use crate::test_support::{
    add_project, add_workspace, migrated_pool, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

async fn issue(
    pool: &SqlitePool,
    project: &str,
    title: &str,
    due: Option<&str>,
    status: &str,
) -> String {
    let id = create(
        pool,
        DEFAULT_WORKSPACE,
        IssueFields {
            title: title.into(),
            due_date: due.map(Into::into),
            ..IssueFields::default()
        },
        Some(project),
    )
    .await
    .unwrap()
    .summary
    .id;
    set_status(pool, DEFAULT_WORKSPACE, &id, status)
        .await
        .unwrap();
    id
}

fn titles(issues: &[IssueSummary]) -> Vec<&str> {
    issues.iter().map(|issue| issue.title.as_str()).collect()
}

#[test]
fn an_empty_project_reports_zeroes_and_no_completion() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Empty").await;
        let view = overview(&pool, DEFAULT_WORKSPACE, &project, "2026-11-16")
            .await
            .unwrap();
        assert_eq!((view.total, view.open, view.closed), (0, 0, 0));
        assert_eq!(view.statuses, StatusCounts::default());
        assert_eq!(view.completion, None);
        assert!(view.overdue.is_empty() && view.upcoming.is_empty());
        assert!(view.milestones.is_empty() && view.activity.is_empty());
    });
}

#[test]
fn counts_statuses_and_excludes_canceled_from_completion() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Launch").await;
        let other = add_project(&pool, DEFAULT_WORKSPACE, "Other").await;
        for (title, status) in [
            ("A", "todo"),
            ("B", "in_progress"),
            ("C", "blocked"),
            ("D", "done"),
            ("E", "done"),
            ("F", "canceled"),
        ] {
            issue(&pool, &project, title, None, status).await;
        }
        issue(&pool, &other, "Elsewhere", None, "done").await;
        let view = overview(&pool, DEFAULT_WORKSPACE, &project, "2026-11-16")
            .await
            .unwrap();
        assert_eq!((view.total, view.open, view.closed), (6, 3, 3));
        assert_eq!(
            view.statuses,
            StatusCounts {
                todo: 1,
                in_progress: 1,
                blocked: 1,
                done: 2,
                canceled: 1,
            }
        );
        // 2 done of 5 non-canceled.
        assert_eq!(view.completion, Some(0.4));
        assert_eq!(view.undated_open, 3);

        // Only canceled issues: nothing counts toward completion.
        let canceled = add_project(&pool, DEFAULT_WORKSPACE, "Canceled").await;
        issue(&pool, &canceled, "Dropped", None, "canceled").await;
        assert_eq!(
            overview(&pool, DEFAULT_WORKSPACE, &canceled, "2026-11-16")
                .await
                .unwrap()
                .completion,
            None
        );
    });
}

#[test]
fn overdue_and_upcoming_follow_the_local_date_boundaries() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Dates").await;
        for (title, due, status) in [
            ("Long overdue", "2026-11-01", "todo"),
            ("Yesterday", "2026-11-15", "blocked"),
            ("Closed late", "2026-11-10", "done"),
            ("Today", "2026-11-16", "todo"),
            ("In six days", "2026-11-22", "todo"),
            ("In a week", "2026-11-23", "todo"),
        ] {
            issue(&pool, &project, title, Some(due), status).await;
        }
        for index in 0..6 {
            issue(
                &pool,
                &project,
                &format!("Also late {index}"),
                Some("2026-11-14"),
                "todo",
            )
            .await;
        }
        let view = overview(&pool, DEFAULT_WORKSPACE, &project, "2026-11-16")
            .await
            .unwrap();
        // Closed issues are never overdue; lists are capped, counts are not.
        assert_eq!(view.overdue_count, 8);
        assert_eq!(view.overdue.len(), 5);
        assert_eq!(&titles(&view.overdue)[..2], ["Long overdue", "Also late 0"]);
        assert_eq!(view.upcoming_count, 2);
        assert_eq!(titles(&view.upcoming), ["Today", "In six days"]);
        assert_eq!(view.undated_open, 0);
        assert_eq!(
            overview(&pool, DEFAULT_WORKSPACE, &project, "16/11/2026").await,
            Err(OverviewError::InvalidDate)
        );
    });
}

#[test]
fn includes_project_milestones_and_labels_activity_by_timestamp() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Launch").await;
        let milestone = crate::milestones::create(
            &pool,
            DEFAULT_WORKSPACE,
            crate::milestones::MilestoneInput {
                title: "Beta".into(),
                ..Default::default()
            },
            Some(&project),
        )
        .await
        .unwrap();
        crate::milestones::create(
            &pool,
            DEFAULT_WORKSPACE,
            crate::milestones::MilestoneInput {
                title: "Workspace wide".into(),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        let first = issue(&pool, &project, "First", None, "todo").await;
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = issue(&pool, &project, "Second", None, "todo").await;
        crate::issues::set_milestone(&pool, DEFAULT_WORKSPACE, &first, Some(&milestone.id))
            .await
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        set_status(&pool, DEFAULT_WORKSPACE, &first, "done")
            .await
            .unwrap();

        let view = overview(&pool, DEFAULT_WORKSPACE, &project, "2026-11-16")
            .await
            .unwrap();
        assert_eq!(view.milestones.len(), 1);
        assert_eq!(view.milestones[0].title, "Beta");
        assert_eq!(view.milestones[0].completed_count, 1);
        let kinds: Vec<_> = view
            .activity
            .iter()
            .map(|event| (event.kind.as_str(), event.issue_id == first))
            .collect();
        // Newest first: the completion, then the creations. The completion's
        // own update is not repeated as "updated".
        assert_eq!(kinds[0], ("completed", true));
        assert!(kinds.contains(&("created", true)));
        assert!(view
            .activity
            .iter()
            .any(|event| event.kind == "created" && event.issue_id == second));
        assert!(!view
            .activity
            .iter()
            .any(|event| event.kind == "updated" && event.issue_id == first));
        assert!(view
            .activity
            .windows(2)
            .all(|pair| pair[0].at >= pair[1].at));
    });
}

#[test]
fn other_workspaces_cannot_read_a_project() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Private").await;
        assert_eq!(
            overview(&pool, OTHER_WORKSPACE, &project, "2026-11-16").await,
            Err(OverviewError::NotFound)
        );
        assert_eq!(
            overview(&pool, DEFAULT_WORKSPACE, "missing", "2026-11-16").await,
            Err(OverviewError::NotFound)
        );
    });
}
