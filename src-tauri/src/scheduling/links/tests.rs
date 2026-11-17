use super::*;
use crate::scheduling::{create_event, events, EventInput};
use crate::test_support::{
    add_project, add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE,
    OTHER_WORKSPACE,
};

async fn event(pool: &SqlitePool, workspace: &str, title: &str) -> String {
    create_event(
        pool,
        workspace,
        EventInput {
            title: title.into(),
            all_day: true,
            start_date: Some("2026-11-18".into()),
            end_date: Some("2026-11-19".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .id
}

async fn document(pool: &SqlitePool, workspace: &str, title: &str) -> String {
    let created = crate::documents::create(pool, workspace, Some(title))
        .await
        .unwrap();
    created.id
}

fn names(records: &[LinkedRecord]) -> Vec<&str> {
    records.iter().map(|record| record.title.as_str()).collect()
}

#[test]
fn links_survive_renames_and_archiving_and_show_current_names() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let meeting = event(&pool, DEFAULT_WORKSPACE, "Kickoff").await;
        let notes = document(&pool, DEFAULT_WORKSPACE, "Notes").await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Launch").await;
        link(&pool, DEFAULT_WORKSPACE, &meeting, Target::Document, &notes)
            .await
            .unwrap();
        let linked = link(
            &pool,
            DEFAULT_WORKSPACE,
            &meeting,
            Target::Project,
            &project,
        )
        .await
        .unwrap();
        assert_eq!(names(&linked.documents), ["Notes"]);
        assert!(!linked.documents[0].archived);

        sqlx::query("UPDATE documents SET title = 'Kickoff notes', archived_at = '2026-11-17T00:00:00Z' WHERE id = ?")
            .bind(&notes)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE projects SET name = 'Launch 2', status = 'archived' WHERE id = ?")
            .bind(&project)
            .execute(&pool)
            .await
            .unwrap();
        let after = links(&pool, DEFAULT_WORKSPACE, &meeting).await.unwrap();
        assert_eq!(names(&after.documents), ["Kickoff notes"]);
        assert!(after.documents[0].archived, "archived stays linked");
        assert_eq!(names(&after.projects), ["Launch 2"]);
        assert!(after.projects[0].archived);
        assert_eq!(after.documents[0].id, notes);
        assert_eq!(after.projects[0].id, project);
    });
}

#[test]
fn duplicate_links_are_ignored_and_unlinking_keeps_every_record() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let meeting = event(&pool, DEFAULT_WORKSPACE, "Kickoff").await;
        let notes = document(&pool, DEFAULT_WORKSPACE, "Notes").await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Launch").await;
        let once = link(&pool, DEFAULT_WORKSPACE, &meeting, Target::Document, &notes)
            .await
            .unwrap();
        let twice = link(&pool, DEFAULT_WORKSPACE, &meeting, Target::Document, &notes)
            .await
            .unwrap();
        assert_eq!(once, twice);
        link(
            &pool,
            DEFAULT_WORKSPACE,
            &meeting,
            Target::Project,
            &project,
        )
        .await
        .unwrap();

        let left = unlink(&pool, DEFAULT_WORKSPACE, &meeting, Target::Document, &notes)
            .await
            .unwrap();
        assert!(left.documents.is_empty());
        assert_eq!(left.projects.len(), 1);
        // Unlinking again is a no-op.
        assert_eq!(
            unlink(&pool, DEFAULT_WORKSPACE, &meeting, Target::Document, &notes)
                .await
                .unwrap(),
            left
        );
        crate::documents::get(&pool, DEFAULT_WORKSPACE, &notes)
            .await
            .unwrap();
        crate::scheduling::get_event(&pool, DEFAULT_WORKSPACE, &meeting)
            .await
            .unwrap();
    });
}

#[test]
fn deleting_either_end_removes_only_the_link() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let meeting = event(&pool, DEFAULT_WORKSPACE, "Kickoff").await;
        let other = event(&pool, DEFAULT_WORKSPACE, "Review").await;
        let notes = document(&pool, DEFAULT_WORKSPACE, "Notes").await;
        let project = add_project(&pool, DEFAULT_WORKSPACE, "Launch").await;
        for id in [&meeting, &other] {
            link(&pool, DEFAULT_WORKSPACE, id, Target::Document, &notes)
                .await
                .unwrap();
            link(&pool, DEFAULT_WORKSPACE, id, Target::Project, &project)
                .await
                .unwrap();
        }
        events::delete(&pool, DEFAULT_WORKSPACE, &meeting)
            .await
            .unwrap();
        // The other event still links, and the records are intact.
        assert_eq!(
            links(&pool, DEFAULT_WORKSPACE, &other)
                .await
                .unwrap()
                .documents
                .len(),
            1
        );
        crate::documents::get(&pool, DEFAULT_WORKSPACE, &notes)
            .await
            .unwrap();

        sqlx::query("DELETE FROM documents WHERE id = ?")
            .bind(&notes)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(&project)
            .execute(&pool)
            .await
            .unwrap();
        let left = links(&pool, DEFAULT_WORKSPACE, &other).await.unwrap();
        assert!(left.documents.is_empty() && left.projects.is_empty());
        crate::scheduling::get_event(&pool, DEFAULT_WORKSPACE, &other)
            .await
            .unwrap();
    });
}

#[test]
fn links_stay_inside_one_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let meeting = event(&pool, DEFAULT_WORKSPACE, "Kickoff").await;
        let foreign_doc = document(&pool, OTHER_WORKSPACE, "Foreign").await;
        let foreign_project = add_project(&pool, OTHER_WORKSPACE, "Foreign").await;

        assert_eq!(
            link(
                &pool,
                DEFAULT_WORKSPACE,
                &meeting,
                Target::Document,
                &foreign_doc
            )
            .await,
            Err(SchedulingError::DocumentNotFound)
        );
        assert_eq!(
            link(
                &pool,
                DEFAULT_WORKSPACE,
                &meeting,
                Target::Project,
                &foreign_project
            )
            .await,
            Err(SchedulingError::ProjectNotFound)
        );
        assert_eq!(
            links(&pool, OTHER_WORKSPACE, &meeting).await,
            Err(SchedulingError::NotFound)
        );
        // Rows written around the commands are refused by triggers.
        let written = sqlx::query(
            "INSERT INTO event_documents (event_id, document_id, workspace_id) VALUES (?, ?, ?)",
        )
        .bind(&meeting)
        .bind(&foreign_doc)
        .bind(DEFAULT_WORKSPACE)
        .execute(&pool)
        .await;
        assert!(written.is_err());
    });
}

#[test]
fn links_survive_a_restart_and_upgrade_from_the_previous_version() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("event-links");
        let pool = database.open().await;
        migrator(22).await.run(&pool).await.unwrap();
        let meeting = event(&pool, DEFAULT_WORKSPACE, "Kickoff").await;
        let notes = document(&pool, DEFAULT_WORKSPACE, "Notes").await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        link(&pool, DEFAULT_WORKSPACE, &meeting, Target::Document, &notes)
            .await
            .unwrap();
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let reopened = links(&pool, DEFAULT_WORKSPACE, &meeting).await.unwrap();
        assert_eq!(names(&reopened.documents), ["Notes"]);
        pool.close().await;
    });
}
