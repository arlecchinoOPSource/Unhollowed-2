use super::*;
use crate::issues::{
    create, query, set_labels, set_milestone, set_rule, set_status, IssueFields, IssueFilter,
    IssueQuery, RecurrenceInput,
};
use crate::test_support::{
    add_issue, add_project, add_workspace, memory_pool, migrated_pool, migrator, DEFAULT_WORKSPACE,
    OTHER_WORKSPACE,
};

async fn titled(pool: &SqlitePool, title: &str, project: Option<&str>) -> String {
    create(
        pool,
        DEFAULT_WORKSPACE,
        IssueFields {
            title: title.into(),
            due_date: Some("2026-11-16".into()),
            ..IssueFields::default()
        },
        project,
    )
    .await
    .unwrap()
    .summary
    .id
}

async fn titles(pool: &SqlitePool, archived: Option<&str>) -> Vec<String> {
    let mut found: Vec<_> = query(
        pool,
        DEFAULT_WORKSPACE,
        IssueQuery {
            filter: IssueFilter {
                state: Some("all".into()),
                archived: archived.map(Into::into),
                ..IssueFilter::default()
            },
            ..IssueQuery::default()
        },
    )
    .await
    .unwrap()
    .issues
    .into_iter()
    .map(|issue| issue.title)
    .collect();
    found.sort();
    found
}

#[test]
fn archiving_and_restoring_keep_identity_status_and_links() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Launch").await;
        let id = titled(&pool, "Old task", Some(&project)).await;
        let child = titled(&pool, "Child", Some(&project)).await;
        crate::relationships::add(
            &pool,
            DEFAULT_WORKSPACE,
            &child,
            &id,
            crate::relationships::RelationKind::Parent,
        )
        .await
        .unwrap();
        let label = crate::labels::create(
            &pool,
            DEFAULT_WORKSPACE,
            crate::labels::LabelInput {
                name: "Keep".into(),
                description: None,
                color: "blue".into(),
            },
        )
        .await
        .unwrap();
        set_labels(&pool, DEFAULT_WORKSPACE, &id, vec![label.id.clone()])
            .await
            .unwrap();
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
        set_milestone(&pool, DEFAULT_WORKSPACE, &id, Some(&milestone.id))
            .await
            .unwrap();
        let before = set_status(&pool, DEFAULT_WORKSPACE, &id, "done")
            .await
            .unwrap();

        let archived = set_archived(&pool, DEFAULT_WORKSPACE, &id, true)
            .await
            .unwrap();
        assert!(archived.summary.archived_at.is_some());
        // Archiving is separate from the lifecycle and changes nothing else.
        assert_eq!(archived.summary.status, "done");
        assert_eq!(archived.summary.completed_at, before.summary.completed_at);
        assert_eq!(archived.summary.updated_at, before.summary.updated_at);
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(
            set_archived(&pool, DEFAULT_WORKSPACE, &id, true)
                .await
                .unwrap(),
            archived
        );

        let restored = set_archived(&pool, DEFAULT_WORKSPACE, &id, false)
            .await
            .unwrap();
        assert_eq!(restored.summary.archived_at, None);
        let mut expected = before;
        expected.summary.archived_at = None;
        assert_eq!(restored, expected);
        // The relationship survived both steps.
        let links = crate::relationships::list(&pool, DEFAULT_WORKSPACE, &id)
            .await
            .unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(
            set_archived(&pool, OTHER_WORKSPACE, &id, true).await,
            Err(IssueError::NotFound)
        );
    });
}

#[test]
fn archived_issues_are_hidden_by_default_everywhere() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Launch").await;
        let kept = titled(&pool, "Kept search word", Some(&project)).await;
        let gone = titled(&pool, "Gone search word", Some(&project)).await;
        let milestone = crate::milestones::create(
            &pool,
            DEFAULT_WORKSPACE,
            crate::milestones::MilestoneInput {
                title: "Beta".into(),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        for id in [&kept, &gone] {
            set_milestone(&pool, DEFAULT_WORKSPACE, id, Some(&milestone.id))
                .await
                .unwrap();
        }
        set_archived(&pool, DEFAULT_WORKSPACE, &gone, true)
            .await
            .unwrap();

        assert_eq!(titles(&pool, None).await, ["Kept search word"]);
        assert_eq!(titles(&pool, Some("exclude")).await, ["Kept search word"]);
        assert_eq!(
            titles(&pool, Some("include")).await,
            ["Gone search word", "Kept search word"]
        );
        assert_eq!(titles(&pool, Some("only")).await, ["Gone search word"]);
        assert_eq!(
            query(
                &pool,
                DEFAULT_WORKSPACE,
                IssueQuery {
                    filter: IssueFilter {
                        archived: Some("maybe".into()),
                        ..IssueFilter::default()
                    },
                    ..IssueQuery::default()
                },
            )
            .await,
            Err(IssueError::InvalidFilter)
        );
        let found = crate::search::search(&pool, DEFAULT_WORKSPACE, "search word")
            .await
            .unwrap();
        assert_eq!(found.issue_total, 1);
        let overview = crate::overview::overview(&pool, DEFAULT_WORKSPACE, &project, "2026-11-16")
            .await
            .unwrap();
        assert_eq!(overview.total, 1);
        assert_eq!(overview.upcoming_count, 1);
        assert_eq!(
            crate::milestones::get(&pool, DEFAULT_WORKSPACE, &milestone.id)
                .await
                .unwrap()
                .open_count,
            1
        );
        // Opening an archived issue directly still works.
        assert!(crate::issues::get(&pool, DEFAULT_WORKSPACE, &gone)
            .await
            .is_ok());
    });
}

#[test]
fn archiving_a_project_keeps_its_issues() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Done project").await;
        let id = titled(&pool, "Leftover", Some(&project)).await;
        let before = crate::issues::get(&pool, DEFAULT_WORKSPACE, &id)
            .await
            .unwrap();
        crate::projects::set_status(&pool, DEFAULT_WORKSPACE, &project, "archived")
            .await
            .unwrap();
        assert_eq!(
            crate::issues::get(&pool, DEFAULT_WORKSPACE, &id)
                .await
                .unwrap(),
            before
        );
        let in_project = query(
            &pool,
            DEFAULT_WORKSPACE,
            IssueQuery {
                filter: IssueFilter {
                    project_ids: vec![project.clone()],
                    ..IssueFilter::default()
                },
                ..IssueQuery::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(in_project.total, 1);
    });
}

#[test]
fn deletion_requires_archive_confirmation_and_no_blockers() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let parent = titled(&pool, "Parent", None).await;
        let child = titled(&pool, "Child", None).await;
        crate::relationships::add(
            &pool,
            DEFAULT_WORKSPACE,
            &child,
            &parent,
            crate::relationships::RelationKind::Parent,
        )
        .await
        .unwrap();

        // Not archived yet.
        assert_eq!(
            delete(&pool, DEFAULT_WORKSPACE, &parent, "ISS-1").await,
            Err(IssueError::NotArchived)
        );
        set_archived(&pool, DEFAULT_WORKSPACE, &parent, true)
            .await
            .unwrap();
        // The typed key must match.
        assert_eq!(
            delete(&pool, DEFAULT_WORKSPACE, &parent, "ISS-2").await,
            Err(IssueError::ConfirmationMismatch)
        );
        // Sub-issues block deletion.
        let impact = deletion_impact(&pool, DEFAULT_WORKSPACE, &parent)
            .await
            .unwrap();
        assert_eq!((impact.key.as_str(), impact.sub_issues), ("ISS-1", 1));
        assert_eq!(
            delete(&pool, DEFAULT_WORKSPACE, &parent, " iss-1 ").await,
            Err(IssueError::HasSubIssues)
        );

        // The latest occurrence of an active series is protected.
        let series = titled(&pool, "Repeats", None).await;
        set_rule(
            &pool,
            DEFAULT_WORKSPACE,
            &series,
            Some(RecurrenceInput {
                frequency: "daily".into(),
                interval: 1,
            }),
        )
        .await
        .unwrap();
        set_archived(&pool, DEFAULT_WORKSPACE, &series, true)
            .await
            .unwrap();
        assert_eq!(
            delete(&pool, DEFAULT_WORKSPACE, &series, "ISS-3").await,
            Err(IssueError::ActiveSeries)
        );
        set_rule(&pool, DEFAULT_WORKSPACE, &series, None)
            .await
            .unwrap();
        delete(&pool, DEFAULT_WORKSPACE, &series, "ISS-3")
            .await
            .unwrap();

        // Other workspaces cannot see or delete it.
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        assert_eq!(
            delete(&pool, OTHER_WORKSPACE, &child, "ISS-2").await,
            Err(IssueError::NotFound)
        );
        assert_eq!(
            deletion_impact(&pool, OTHER_WORKSPACE, &child).await,
            Err(IssueError::NotFound)
        );
    });
}

#[test]
fn deleting_removes_only_links_and_never_reuses_the_number() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Launch").await;
        let id = titled(&pool, "Temporary", Some(&project)).await;
        let other = add_issue(&pool, DEFAULT_WORKSPACE, Some(&project)).await;
        crate::relationships::add(
            &pool,
            DEFAULT_WORKSPACE,
            &id,
            &other,
            crate::relationships::RelationKind::Blocks,
        )
        .await
        .unwrap();
        let label = crate::labels::create(
            &pool,
            DEFAULT_WORKSPACE,
            crate::labels::LabelInput {
                name: "Tag".into(),
                description: None,
                color: "red".into(),
            },
        )
        .await
        .unwrap();
        set_labels(&pool, DEFAULT_WORKSPACE, &id, vec![label.id.clone()])
            .await
            .unwrap();
        let document = crate::documents::create(&pool, DEFAULT_WORKSPACE, Some("Notes"))
            .await
            .unwrap();
        crate::document_links::link(
            &pool,
            DEFAULT_WORKSPACE,
            crate::document_links::Owner::Issue,
            &id,
            &document.id,
        )
        .await
        .unwrap();
        set_archived(&pool, DEFAULT_WORKSPACE, &id, true)
            .await
            .unwrap();

        let impact = deletion_impact(&pool, DEFAULT_WORKSPACE, &id)
            .await
            .unwrap();
        assert_eq!(
            (
                impact.labels,
                impact.documents,
                impact.relationships,
                impact.sub_issues
            ),
            (1, 1, 1, 0)
        );
        delete(&pool, DEFAULT_WORKSPACE, &id, "ISS-1")
            .await
            .unwrap();

        assert_eq!(
            crate::issues::get(&pool, DEFAULT_WORKSPACE, &id).await,
            Err(IssueError::NotFound)
        );
        // Linked records remain; only the links went.
        assert!(
            crate::documents::get(&pool, DEFAULT_WORKSPACE, &document.id)
                .await
                .is_ok()
        );
        assert_eq!(
            crate::labels::get(&pool, DEFAULT_WORKSPACE, &label.id)
                .await
                .unwrap()
                .issue_count,
            0
        );
        assert!(crate::issues::get(&pool, DEFAULT_WORKSPACE, &other)
            .await
            .is_ok());
        assert!(crate::relationships::list(&pool, DEFAULT_WORKSPACE, &other)
            .await
            .unwrap()
            .is_empty());
        let next = titled(&pool, "Next", None).await;
        assert_eq!(
            crate::issues::get(&pool, DEFAULT_WORKSPACE, &next)
                .await
                .unwrap()
                .summary
                .number,
            3
        );
    });
}

#[test]
fn upgrading_starts_with_nothing_archived() {
    tauri::async_runtime::block_on(async {
        let pool = memory_pool().await;
        migrator(13).await.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO issues (id, workspace_id, number, title, description)
             VALUES ('before', ?, 1, 'Before', '{\"type\":\"doc\"}')",
        )
        .bind(DEFAULT_WORKSPACE)
        .execute(&pool)
        .await
        .unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let issue = crate::issues::get(&pool, DEFAULT_WORKSPACE, "before")
            .await
            .unwrap();
        assert_eq!(issue.summary.archived_at, None);
        assert_eq!(titles(&pool, None).await, ["Before"]);
    });
}
