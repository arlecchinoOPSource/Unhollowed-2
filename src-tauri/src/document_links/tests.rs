use super::*;
use crate::test_support::{
    add_issue, add_project, add_workspace, memory_pool, migrated_pool, migrator, TempDatabase,
    DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

const RICH: &str = r#"{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Plan"}]},{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Keep"}]}]}"#;

async fn document(pool: &SqlitePool, workspace: &str, title: &str) -> String {
    let created = crate::documents::create(pool, workspace, Some(title))
        .await
        .unwrap();
    crate::documents::update(pool, workspace, &created.id, title, RICH)
        .await
        .unwrap();
    created.id
}

fn titles(documents: &[LinkedDocument]) -> Vec<&str> {
    documents
        .iter()
        .map(|document| document.title.as_str())
        .collect()
}

#[test]
fn links_and_unlinks_documents_without_touching_their_content() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("document-links");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let issue = add_issue(&pool, DEFAULT_WORKSPACE, None).await;
        let spec = document(&pool, DEFAULT_WORKSPACE, "Spec").await;
        let notes = document(&pool, DEFAULT_WORKSPACE, "Notes").await;
        let before = crate::documents::get(&pool, DEFAULT_WORKSPACE, &spec)
            .await
            .unwrap();

        link(&pool, DEFAULT_WORKSPACE, Owner::Issue, &issue, &spec)
            .await
            .unwrap();
        let both = link(&pool, DEFAULT_WORKSPACE, Owner::Issue, &issue, &notes)
            .await
            .unwrap();
        assert_eq!(titles(&both), ["Notes", "Spec"]);
        // Linking again is a no-op.
        assert_eq!(
            link(&pool, DEFAULT_WORKSPACE, Owner::Issue, &issue, &spec)
                .await
                .unwrap(),
            both
        );
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(
            linked(&pool, DEFAULT_WORKSPACE, Owner::Issue, &issue)
                .await
                .unwrap(),
            both
        );
        let left = unlink(&pool, DEFAULT_WORKSPACE, Owner::Issue, &issue, &spec)
            .await
            .unwrap();
        assert_eq!(titles(&left), ["Notes"]);
        // Unlinking again is a no-op, and the document is unchanged.
        assert_eq!(
            unlink(&pool, DEFAULT_WORKSPACE, Owner::Issue, &issue, &spec)
                .await
                .unwrap(),
            left
        );
        assert_eq!(
            crate::documents::get(&pool, DEFAULT_WORKSPACE, &spec)
                .await
                .unwrap(),
            before
        );
        assert_eq!(before.content, RICH);
        pool.close().await;
    });
}

#[test]
fn projects_show_direct_links_and_links_inherited_through_issues() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Launch").await;
        let other = add_project(&pool, DEFAULT_WORKSPACE, "Other").await;
        let first = add_issue(&pool, DEFAULT_WORKSPACE, Some(&project)).await;
        let second = add_issue(&pool, DEFAULT_WORKSPACE, Some(&project)).await;
        let elsewhere = add_issue(&pool, DEFAULT_WORKSPACE, Some(&other)).await;
        let brief = document(&pool, DEFAULT_WORKSPACE, "Brief").await;
        let research = document(&pool, DEFAULT_WORKSPACE, "Research").await;
        let unrelated = document(&pool, DEFAULT_WORKSPACE, "Unrelated").await;

        link(&pool, DEFAULT_WORKSPACE, Owner::Project, &project, &brief)
            .await
            .unwrap();
        for issue in [&first, &second] {
            link(&pool, DEFAULT_WORKSPACE, Owner::Issue, issue, &research)
                .await
                .unwrap();
        }
        // Already linked to the project directly, so not repeated as inherited.
        link(&pool, DEFAULT_WORKSPACE, Owner::Issue, &first, &brief)
            .await
            .unwrap();
        link(
            &pool,
            DEFAULT_WORKSPACE,
            Owner::Issue,
            &elsewhere,
            &unrelated,
        )
        .await
        .unwrap();

        let documents = for_project(&pool, DEFAULT_WORKSPACE, &project)
            .await
            .unwrap();
        assert_eq!(titles(&documents.direct), ["Brief"]);
        assert_eq!(documents.via_issues.len(), 1);
        assert_eq!(documents.via_issues[0].title, "Research");
        let numbers: Vec<_> = documents.via_issues[0]
            .issues
            .iter()
            .map(|issue| issue.number)
            .collect();
        assert_eq!(numbers, [1, 2]);

        // Moving an issue out of the project removes its inherited links.
        crate::issues::set_project(&pool, DEFAULT_WORKSPACE, &first, Some(&other))
            .await
            .unwrap();
        crate::issues::set_project(&pool, DEFAULT_WORKSPACE, &second, None)
            .await
            .unwrap();
        assert!(for_project(&pool, DEFAULT_WORKSPACE, &project)
            .await
            .unwrap()
            .via_issues
            .is_empty());

        // Navigating back from a document.
        let used = usage(&pool, DEFAULT_WORKSPACE, &brief).await.unwrap();
        assert_eq!(used.projects.len(), 1);
        assert_eq!(used.projects[0].name, "Launch");
        assert_eq!(used.issues.len(), 1);
        assert_eq!(used.issues[0].id, first);
    });
}

#[test]
fn rejects_missing_and_cross_workspace_records() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let issue = add_issue(&pool, DEFAULT_WORKSPACE, None).await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Mine").await;
        let mine = document(&pool, DEFAULT_WORKSPACE, "Mine").await;
        let theirs = document(&pool, OTHER_WORKSPACE, "Theirs").await;
        let their_issue = add_issue(&pool, OTHER_WORKSPACE, None).await;

        for document in [theirs.as_str(), "missing"] {
            assert_eq!(
                link(&pool, DEFAULT_WORKSPACE, Owner::Issue, &issue, document).await,
                Err(LinkError::DocumentNotFound)
            );
            assert_eq!(
                link(&pool, DEFAULT_WORKSPACE, Owner::Project, &project, document).await,
                Err(LinkError::DocumentNotFound)
            );
        }
        for id in [their_issue.as_str(), "missing"] {
            assert_eq!(
                link(&pool, DEFAULT_WORKSPACE, Owner::Issue, id, &mine).await,
                Err(LinkError::NotFound)
            );
            assert_eq!(
                linked(&pool, DEFAULT_WORKSPACE, Owner::Issue, id).await,
                Err(LinkError::NotFound)
            );
        }
        assert_eq!(
            for_project(&pool, OTHER_WORKSPACE, &project).await,
            Err(LinkError::NotFound)
        );
        assert_eq!(
            usage(&pool, OTHER_WORKSPACE, &mine).await,
            Err(LinkError::DocumentNotFound)
        );

        // The schema enforces the same boundary, and links are unique.
        let insert =
            "INSERT INTO issue_documents (issue_id, document_id, workspace_id) VALUES (?, ?, ?)";
        assert!(sqlx::query(insert)
            .bind(&issue)
            .bind(&theirs)
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .is_err());
        sqlx::query(insert)
            .bind(&issue)
            .bind(&mine)
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .unwrap();
        assert!(sqlx::query(insert)
            .bind(&issue)
            .bind(&mine)
            .bind(DEFAULT_WORKSPACE)
            .execute(&pool)
            .await
            .is_err());

        // A link disappears with its issue; the document stays.
        sqlx::query("DELETE FROM issues WHERE id = ?")
            .bind(&issue)
            .execute(&pool)
            .await
            .unwrap();
        assert!(usage(&pool, DEFAULT_WORKSPACE, &mine)
            .await
            .unwrap()
            .issues
            .is_empty());
        assert!(crate::documents::get(&pool, DEFAULT_WORKSPACE, &mine)
            .await
            .is_ok());
    });
}

#[test]
fn upgrading_keeps_documents_and_starts_without_links() {
    tauri::async_runtime::block_on(async {
        let pool = memory_pool().await;
        migrator(12).await.run(&pool).await.unwrap();
        let kept = crate::documents::create(&pool, DEFAULT_WORKSPACE, Some("Before"))
            .await
            .unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(
            crate::documents::get(&pool, DEFAULT_WORKSPACE, &kept.id)
                .await
                .unwrap(),
            kept
        );
        let used = usage(&pool, DEFAULT_WORKSPACE, &kept.id).await.unwrap();
        assert!(used.issues.is_empty() && used.projects.is_empty());
    });
}
