use super::*;
use crate::issues::{create, set_status, IssueFields};
use crate::test_support::{
    add_project, add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE,
    OTHER_WORKSPACE,
};

async fn issue(pool: &SqlitePool, workspace: &str, title: &str) -> IssueSummary {
    create(
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
}

async fn milestone(pool: &SqlitePool, title: &str, project: Option<&str>) {
    crate::milestones::create(
        pool,
        DEFAULT_WORKSPACE,
        crate::milestones::MilestoneInput {
            title: title.into(),
            ..Default::default()
        },
        project,
    )
    .await
    .unwrap();
}

#[test]
fn finds_projects_issues_and_milestones_ranked_and_grouped() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let launch = add_project(&pool, DEFAULT_WORKSPACE, "Café launch").await;
        add_project(&pool, DEFAULT_WORKSPACE, "Relaunch website").await;
        add_project(&pool, DEFAULT_WORKSPACE, "Garden").await;
        let old = issue(&pool, DEFAULT_WORKSPACE, "Launch party").await;
        set_status(&pool, DEFAULT_WORKSPACE, &old.id, "done")
            .await
            .unwrap();
        issue(&pool, DEFAULT_WORKSPACE, "Print launch posters").await;
        milestone(&pool, "Launch day", Some(&launch)).await;
        milestone(&pool, "Unrelated", None).await;

        let found = search(&pool, DEFAULT_WORKSPACE, "  LAUNCH ").await.unwrap();
        // Prefix matches first, regardless of case and accents.
        let names: Vec<_> = found.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Café launch", "Relaunch website"]);
        // Open issues before closed ones.
        let titles: Vec<_> = found.issues.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles, ["Print launch posters", "Launch party"]);
        assert_eq!(found.issue_total, 2);
        assert_eq!(found.milestones.len(), 1);
        assert_eq!(
            found.milestones[0].project_name.as_deref(),
            Some("Café launch")
        );

        // Unicode case folding and literal characters.
        assert_eq!(
            search(&pool, DEFAULT_WORKSPACE, "CAFÉ")
                .await
                .unwrap()
                .projects
                .len(),
            1
        );
        assert_eq!(
            search(&pool, DEFAULT_WORKSPACE, "%").await.unwrap(),
            SearchResults::default()
        );
        // Empty and overly long text return nothing.
        for text in ["", "   ", &"x".repeat(201)] {
            assert_eq!(
                search(&pool, DEFAULT_WORKSPACE, text).await.unwrap(),
                SearchResults::default()
            );
        }
    });
}

#[test]
fn readable_issue_numbers_jump_to_that_issue() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for index in 1..=12 {
            issue(&pool, DEFAULT_WORKSPACE, &format!("Task 1{index}")).await;
        }
        for text in ["ISS-12", "iss-12", "#12", "12"] {
            let found = search(&pool, DEFAULT_WORKSPACE, text).await.unwrap();
            assert_eq!(found.issues[0].number, 12, "{text}");
        }
        // "12" also matches titles containing it, after the exact number.
        let found = search(&pool, DEFAULT_WORKSPACE, "12").await.unwrap();
        assert!(found.issue_total >= 2);
        assert!(search(&pool, DEFAULT_WORKSPACE, "ISS-99")
            .await
            .unwrap()
            .issues
            .is_empty());
    });
}

#[test]
fn caps_each_group_and_reports_totals() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for index in 0..20 {
            add_project(
                &pool,
                DEFAULT_WORKSPACE,
                &format!("Alpha project {index:02}"),
            )
            .await;
            issue(&pool, DEFAULT_WORKSPACE, &format!("Alpha issue {index}")).await;
            milestone(&pool, &format!("Alpha milestone {index}"), None).await;
        }
        let found = search(&pool, DEFAULT_WORKSPACE, "alpha").await.unwrap();
        assert_eq!(found.projects.len(), GROUP_LIMIT);
        assert_eq!(found.issues.len(), GROUP_LIMIT);
        assert_eq!(found.milestones.len(), GROUP_LIMIT);
        assert_eq!(
            (
                found.project_total,
                found.issue_total,
                found.milestone_total
            ),
            (20, 20, 20)
        );
    });
}

#[test]
fn never_returns_another_workspaces_records() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        add_project(&pool, OTHER_WORKSPACE, "Secret plan").await;
        issue(&pool, OTHER_WORKSPACE, "Secret task").await;
        let found = search(&pool, DEFAULT_WORKSPACE, "secret").await.unwrap();
        assert_eq!(found, SearchResults::default());
        assert_eq!(
            search(&pool, OTHER_WORKSPACE, "secret")
                .await
                .unwrap()
                .issue_total,
            1
        );
    });
}

/// The query plans read one workspace through a workspace-leading index.
#[test]
fn every_query_is_driven_by_a_workspace_index() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let plans = [
            "SELECT id, name, description, status FROM projects WHERE workspace_id = ?",
            "SELECT count(*) FROM issues WHERE workspace_id = ?1 AND (instr(search_text, ?2) > 0 OR number IS ?3)",
            "SELECT m.id FROM milestones AS m LEFT JOIN projects AS p ON p.id = m.project_id WHERE m.workspace_id = ?",
        ];
        for sql in plans {
            let rows: Vec<(i64, i64, i64, String)> =
                sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                    .bind(DEFAULT_WORKSPACE)
                    .bind("x")
                    .bind(1)
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let detail = rows[0].3.clone();
            assert!(
                detail.starts_with("SEARCH") && detail.contains("workspace_id=?"),
                "{sql}: {detail}"
            );
        }
    });
}

/// Run with `cargo test search::tests::measure -- --ignored --nocapture`.
#[test]
#[ignore]
fn measure() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("search-measure");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        for workspace in [DEFAULT_WORKSPACE, OTHER_WORKSPACE] {
            for index in 0..300 {
                add_project(&pool, workspace, &format!("Project {index} launch")).await;
            }
            for index in 0..300 {
                sqlx::query("INSERT INTO milestones (id, workspace_id, title) VALUES (?, ?, ?)")
                    .bind(uuid::Uuid::new_v4().to_string())
                    .bind(workspace)
                    .bind(format!("Milestone {index}"))
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            for index in 0..5000 {
                issue(
                    &pool,
                    workspace,
                    &format!("Issue {index} about launch plans"),
                )
                .await;
            }
        }
        search(&pool, DEFAULT_WORKSPACE, "warm").await.unwrap();
        for text in ["launch", "issue 4999", "iss-4321", "nothing matches"] {
            let start = std::time::Instant::now();
            for _ in 0..20 {
                search(&pool, DEFAULT_WORKSPACE, text).await.unwrap();
            }
            println!("{text:>16}: {:?} per search", start.elapsed() / 20);
        }
        pool.close().await;
    });
}
