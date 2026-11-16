use super::*;
use crate::issues::{self, IssueError, IssueFields, IssueFilter, IssueQuery};
use crate::test_support::{
    add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

fn input(name: &str, color: &str) -> LabelInput {
    LabelInput {
        name: name.into(),
        description: None,
        color: color.into(),
    }
}

async fn issue(pool: &SqlitePool, workspace: &str, title: &str) -> String {
    issues::create(
        pool,
        workspace,
        IssueFields {
            title: title.into(),
            ..IssueFields::default()
        },
        None,
    )
    .await
    .unwrap()
    .summary
    .id
}

fn ids(issue: &issues::Issue) -> Vec<&str> {
    issue
        .summary
        .label_ids
        .0
        .iter()
        .map(String::as_str)
        .collect()
}

#[test]
fn creates_renames_recolors_archives_and_restores_labels() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("labels-lifecycle");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let label = create(
            &pool,
            DEFAULT_WORKSPACE,
            LabelInput {
                name: "  Research ".into(),
                description: Some(" Reading and notes ".into()),
                color: "teal".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(label.name, "Research");
        assert_eq!(label.description.as_deref(), Some("Reading and notes"));
        assert!(!label.archived);
        assert_eq!(label.issue_count, 0);

        let renamed = update(
            &pool,
            DEFAULT_WORKSPACE,
            &label.id,
            input("Reading", "purple"),
        )
        .await
        .unwrap();
        assert_eq!(
            (renamed.name.as_str(), renamed.color.as_str()),
            ("Reading", "purple")
        );
        assert_eq!(renamed.description, None);
        assert_eq!(renamed.created_at, label.created_at);

        let archived = set_archived(&pool, DEFAULT_WORKSPACE, &label.id, true)
            .await
            .unwrap();
        assert!(archived.archived && archived.archived_at.is_some());
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(
            set_archived(&pool, DEFAULT_WORKSPACE, &label.id, true)
                .await
                .unwrap(),
            archived
        );
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, &label.id).await.unwrap(),
            archived
        );
        let restored = set_archived(&pool, DEFAULT_WORKSPACE, &label.id, false)
            .await
            .unwrap();
        assert!(!restored.archived && restored.archived_at.is_none());
        pool.close().await;
    });
}

#[test]
fn rejects_invalid_and_duplicate_labels_per_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let label = create(&pool, DEFAULT_WORKSPACE, input("Économie", "blue"))
            .await
            .unwrap();
        let other = create(&pool, DEFAULT_WORKSPACE, input("Errands", "red"))
            .await
            .unwrap();
        // Names compare case-insensitively with Unicode rules.
        assert_eq!(
            create(&pool, DEFAULT_WORKSPACE, input(" économie ", "red")).await,
            Err(LabelError::DuplicateName)
        );
        assert_eq!(
            update(
                &pool,
                DEFAULT_WORKSPACE,
                &other.id,
                input("ÉCONOMIE", "red")
            )
            .await,
            Err(LabelError::DuplicateName)
        );
        // Archived labels keep their name reserved.
        set_archived(&pool, DEFAULT_WORKSPACE, &label.id, true)
            .await
            .unwrap();
        assert_eq!(
            create(&pool, DEFAULT_WORKSPACE, input("économie", "red")).await,
            Err(LabelError::DuplicateName)
        );
        // Another workspace can use the same name.
        create(&pool, OTHER_WORKSPACE, input("Économie", "blue"))
            .await
            .unwrap();
        assert_eq!(list(&pool, OTHER_WORKSPACE).await.unwrap().len(), 1);
        assert_eq!(
            get(&pool, OTHER_WORKSPACE, &label.id).await,
            Err(LabelError::NotFound)
        );
        assert_eq!(
            update(&pool, OTHER_WORKSPACE, &label.id, input("Taken", "red")).await,
            Err(LabelError::NotFound)
        );
        assert_eq!(
            set_archived(&pool, OTHER_WORKSPACE, &label.id, false).await,
            Err(LabelError::NotFound)
        );

        for (bad, error) in [
            (input("  ", "red"), LabelError::InvalidName),
            (input(&"x".repeat(51), "red"), LabelError::InvalidName),
            (input("Fine", "crimson"), LabelError::InvalidColor),
            (
                LabelInput {
                    description: Some("x".repeat(501)),
                    ..input("Fine", "red")
                },
                LabelError::InvalidDescription,
            ),
        ] {
            assert_eq!(create(&pool, DEFAULT_WORKSPACE, bad).await, Err(error));
        }
        // Active labels first, then archived, each by name.
        let names: Vec<_> = list(&pool, DEFAULT_WORKSPACE)
            .await
            .unwrap()
            .into_iter()
            .map(|label| label.name)
            .collect();
        assert_eq!(names, ["Errands", "Économie"]);
    });
}

#[test]
fn issues_carry_several_labels_and_keep_archived_ones() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let bug = create(&pool, DEFAULT_WORKSPACE, input("Bug", "red"))
            .await
            .unwrap();
        let home = create(&pool, DEFAULT_WORKSPACE, input("Home", "green"))
            .await
            .unwrap();
        let old = create(&pool, DEFAULT_WORKSPACE, input("Old", "gray"))
            .await
            .unwrap();
        let id = issue(&pool, DEFAULT_WORKSPACE, "Fix sink").await;

        let mut wanted = vec![
            home.id.clone(),
            bug.id.clone(),
            old.id.clone(),
            bug.id.clone(),
        ];
        let labeled = issues::set_labels(&pool, DEFAULT_WORKSPACE, &id, wanted.clone())
            .await
            .unwrap();
        wanted.sort();
        wanted.dedup();
        assert_eq!(ids(&labeled), wanted);
        assert_eq!(
            labeled.summary.label_ids,
            issues::get(&pool, DEFAULT_WORKSPACE, &id)
                .await
                .unwrap()
                .summary
                .label_ids
        );
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, &bug.id)
                .await
                .unwrap()
                .issue_count,
            1
        );

        // A retry with the same set changes nothing, including updated_at.
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(
            issues::set_labels(&pool, DEFAULT_WORKSPACE, &id, wanted.clone())
                .await
                .unwrap(),
            labeled
        );

        // Archiving keeps the historical link visible.
        set_archived(&pool, DEFAULT_WORKSPACE, &old.id, true)
            .await
            .unwrap();
        let kept = issues::get(&pool, DEFAULT_WORKSPACE, &id).await.unwrap();
        assert!(ids(&kept).contains(&old.id.as_str()));
        // Keeping it while removing others is allowed.
        let kept = issues::set_labels(&pool, DEFAULT_WORKSPACE, &id, vec![old.id.clone()])
            .await
            .unwrap();
        assert_eq!(ids(&kept), [old.id.as_str()]);
        // Removing it is allowed, and it cannot be added back while archived.
        let cleared = issues::set_labels(&pool, DEFAULT_WORKSPACE, &id, vec![])
            .await
            .unwrap();
        assert!(cleared.summary.label_ids.0.is_empty());
        assert_eq!(
            issues::set_labels(
                &pool,
                DEFAULT_WORKSPACE,
                &id,
                vec![bug.id.clone(), old.id.clone()]
            )
            .await,
            Err(IssueError::LabelArchived)
        );
        // The failed request rolled back entirely, including the valid label.
        assert!(issues::get(&pool, DEFAULT_WORKSPACE, &id)
            .await
            .unwrap()
            .summary
            .label_ids
            .0
            .is_empty());
        let other_issue = issue(&pool, DEFAULT_WORKSPACE, "Other").await;
        assert_eq!(
            issues::set_labels(&pool, DEFAULT_WORKSPACE, &other_issue, vec![old.id.clone()]).await,
            Err(IssueError::LabelArchived)
        );
    });
}

#[test]
fn label_links_stay_inside_one_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let mine = create(&pool, DEFAULT_WORKSPACE, input("Mine", "red"))
            .await
            .unwrap();
        let theirs = create(&pool, OTHER_WORKSPACE, input("Theirs", "blue"))
            .await
            .unwrap();
        let my_issue = issue(&pool, DEFAULT_WORKSPACE, "Mine").await;
        let their_issue = issue(&pool, OTHER_WORKSPACE, "Theirs").await;

        for label in [theirs.id.as_str(), "missing"] {
            assert_eq!(
                issues::set_labels(&pool, DEFAULT_WORKSPACE, &my_issue, vec![label.into()]).await,
                Err(IssueError::InvalidLabel)
            );
        }
        assert_eq!(
            issues::set_labels(
                &pool,
                DEFAULT_WORKSPACE,
                &their_issue,
                vec![mine.id.clone()]
            )
            .await,
            Err(IssueError::NotFound)
        );
        assert_eq!(
            issues::set_labels(&pool, DEFAULT_WORKSPACE, "missing", vec![]).await,
            Err(IssueError::NotFound)
        );

        // The schema enforces the same rules.
        let link = "INSERT INTO issue_labels (issue_id, label_id, workspace_id) VALUES (?, ?, ?)";
        for (issue_id, label_id, workspace) in [
            (&my_issue, &theirs.id, DEFAULT_WORKSPACE),
            (&their_issue, &mine.id, DEFAULT_WORKSPACE),
            (&my_issue, &mine.id, OTHER_WORKSPACE),
        ] {
            assert!(sqlx::query(link)
                .bind(issue_id)
                .bind(label_id)
                .bind(workspace)
                .execute(&pool)
                .await
                .is_err());
        }
        sqlx::query(link)
            .bind(&my_issue)
            .bind(&mine.id)
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .unwrap();
        // Links are unique.
        assert!(sqlx::query(link)
            .bind(&my_issue)
            .bind(&mine.id)
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .is_err());
        set_archived(&pool, DEFAULT_WORKSPACE, &mine.id, true)
            .await
            .unwrap();
        let second = issue(&pool, DEFAULT_WORKSPACE, "Second").await;
        assert!(sqlx::query(link)
            .bind(&second)
            .bind(&mine.id)
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .is_err());
        // Deleting an issue removes its links.
        sqlx::query("DELETE FROM issues WHERE id = ?")
            .bind(&my_issue)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, &mine.id)
                .await
                .unwrap()
                .issue_count,
            0
        );
    });
}

#[test]
fn filters_issues_by_any_or_all_labels_including_archived() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let red = create(&pool, DEFAULT_WORKSPACE, input("Red", "red"))
            .await
            .unwrap();
        let blue = create(&pool, DEFAULT_WORKSPACE, input("Blue", "blue"))
            .await
            .unwrap();
        for (title, labels) in [
            ("Both", vec![red.id.clone(), blue.id.clone()]),
            ("Only red", vec![red.id.clone()]),
            ("Only blue", vec![blue.id.clone()]),
            ("None", vec![]),
        ] {
            let id = issue(&pool, DEFAULT_WORKSPACE, title).await;
            issues::set_labels(&pool, DEFAULT_WORKSPACE, &id, labels)
                .await
                .unwrap();
        }
        let run = |labels: Vec<String>, label_match: Option<&str>| {
            let pool = pool.clone();
            let label_match = label_match.map(str::to_owned);
            async move {
                issues::query(
                    &pool,
                    DEFAULT_WORKSPACE,
                    IssueQuery {
                        filter: IssueFilter {
                            label_ids: labels,
                            label_match,
                            ..IssueFilter::default()
                        },
                        sort: Some("title".into()),
                        ..IssueQuery::default()
                    },
                )
                .await
                .unwrap()
                .issues
                .into_iter()
                .map(|issue| issue.title)
                .collect::<Vec<_>>()
            }
        };
        let both = vec![red.id.clone(), blue.id.clone()];
        assert_eq!(
            run(both.clone(), None).await,
            ["Both", "Only blue", "Only red"]
        );
        assert_eq!(run(both.clone(), Some("all")).await, ["Both"]);
        assert_eq!(run(vec![red.id.clone()], None).await, ["Both", "Only red"]);
        // Archived labels still find their historical issues.
        set_archived(&pool, DEFAULT_WORKSPACE, &red.id, true)
            .await
            .unwrap();
        assert_eq!(
            run(vec![red.id.clone()], Some("all")).await,
            ["Both", "Only red"]
        );
        assert_eq!(
            issues::query(
                &pool,
                DEFAULT_WORKSPACE,
                IssueQuery {
                    filter: IssueFilter {
                        label_match: Some("some".into()),
                        ..IssueFilter::default()
                    },
                    ..IssueQuery::default()
                },
            )
            .await,
            Err(IssueError::InvalidFilter)
        );
    });
}

#[test]
fn upgrading_keeps_issues_and_adds_empty_labels() {
    tauri::async_runtime::block_on(async {
        let pool = crate::test_support::memory_pool().await;
        migrator(6).await.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO issues (id, workspace_id, number, title, description)
             VALUES ('before', ?, 1, 'Before labels', '{\"type\":\"doc\"}')",
        )
        .bind(DEFAULT_WORKSPACE)
        .execute(&pool)
        .await
        .unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let existing = issues::get(&pool, DEFAULT_WORKSPACE, "before")
            .await
            .unwrap();
        assert_eq!(existing.summary.title, "Before labels");
        assert!(existing.summary.label_ids.0.is_empty());
        assert!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().is_empty());
    });
}
