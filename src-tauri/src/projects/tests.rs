use super::*;
use crate::test_support::{
    add_workspace, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

fn input(name: &str) -> ProjectInput {
    ProjectInput {
        name: name.into(),
        description: Some("  Sample brief  ".into()),
        start_date: Some("2028-02-29".into()),
        target_date: Some("2028-03-02".into()),
    }
}

#[test]
fn creates_and_lists_a_project_after_reopening_the_database() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("projects-reopen");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let project = create(&pool, DEFAULT_WORKSPACE, input("  Field notes  "))
            .await
            .unwrap();
        assert!(Uuid::parse_str(&project.id).is_ok());
        assert_eq!(project.name, "Field notes");
        assert_eq!(project.description.as_deref(), Some("Sample brief"));
        assert_eq!(project.status, "planned");
        assert_eq!(project.start_date.as_deref(), Some("2028-02-29"));
        assert_eq!(project.target_date.as_deref(), Some("2028-03-02"));
        assert_eq!(project.created_at, project.updated_at);
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, &project.id).await.unwrap(),
            project
        );
        assert_eq!(list(&pool, DEFAULT_WORKSPACE).await.unwrap(), vec![project]);
        pool.close().await;
    });
}

#[test]
fn updates_info_changes_status_and_archives_without_removing_the_project() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = create(&pool, DEFAULT_WORKSPACE, input("Original"))
            .await
            .unwrap();
        let id = &project.id;

        let mut changes = input("Revised");
        changes.description = Some(" ".into());
        changes.start_date = None;
        changes.target_date = None;
        let edited = update(&pool, DEFAULT_WORKSPACE, id, changes).await.unwrap();
        assert_eq!(edited.id, project.id);
        assert_eq!(edited.created_at, project.created_at);
        assert!(edited.updated_at >= project.updated_at);
        assert_eq!(edited.name, "Revised");
        assert_eq!(edited.description, None);
        assert_eq!(edited.start_date, None);
        assert_eq!(edited.target_date, None);

        for status in ["active", "on_hold", "completed", "archived"] {
            let changed = set_status(&pool, DEFAULT_WORKSPACE, id, status)
                .await
                .unwrap();
            assert_eq!(changed.status, status);
            assert_eq!(changed.name, "Revised");
        }
        let archived = get(&pool, DEFAULT_WORKSPACE, id).await.unwrap();
        assert_eq!(archived.status, "archived");
        assert_eq!(
            list(&pool, DEFAULT_WORKSPACE).await.unwrap(),
            vec![archived]
        );
    });
}

#[test]
fn scopes_every_project_query_to_its_owner() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let project = create(&pool, DEFAULT_WORKSPACE, input("Personal"))
            .await
            .unwrap();
        let other = create(&pool, OTHER_WORKSPACE, input("Shared name"))
            .await
            .unwrap();
        assert_eq!(list(&pool, OTHER_WORKSPACE).await.unwrap(), vec![other]);
        assert_eq!(
            get(&pool, OTHER_WORKSPACE, &project.id).await,
            Err(ProjectError::NotFound)
        );
        assert_eq!(
            update(&pool, OTHER_WORKSPACE, &project.id, input("Wrong")).await,
            Err(ProjectError::NotFound)
        );
        assert_eq!(
            set_status(&pool, OTHER_WORKSPACE, &project.id, "archived").await,
            Err(ProjectError::NotFound)
        );
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, &project.id).await.unwrap(),
            project
        );
        assert!(sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(OTHER_WORKSPACE)
            .execute(&pool)
            .await
            .is_err());
    });
}

#[test]
fn rejects_invalid_input_and_keeps_existing_data() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let project = create(&pool, DEFAULT_WORKSPACE, input("Valid"))
            .await
            .unwrap();
        assert_eq!(
            create(&pool, DEFAULT_WORKSPACE, input("  ")).await,
            Err(ProjectError::InvalidName)
        );
        assert_eq!(
            create(&pool, DEFAULT_WORKSPACE, input(&"x".repeat(201))).await,
            Err(ProjectError::InvalidName)
        );
        let mut invalid = input("Valid");
        invalid.description = Some("x".repeat(5001));
        assert_eq!(
            create(&pool, DEFAULT_WORKSPACE, invalid).await,
            Err(ProjectError::InvalidDescription)
        );
        for date in ["2027-02-29", "2026-04-31", "2026-3-01", "0000-01-01"] {
            let mut invalid = input("Valid");
            invalid.start_date = Some(date.into());
            assert_eq!(
                update(&pool, DEFAULT_WORKSPACE, &project.id, invalid).await,
                Err(ProjectError::InvalidDate)
            );
        }
        let mut invalid = input("Valid");
        invalid.target_date = Some("2028-01-01".into());
        assert_eq!(
            update(&pool, DEFAULT_WORKSPACE, &project.id, invalid).await,
            Err(ProjectError::InvalidDateRange)
        );
        assert_eq!(
            set_status(&pool, DEFAULT_WORKSPACE, &project.id, "done").await,
            Err(ProjectError::InvalidStatus)
        );
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, &project.id).await.unwrap(),
            project
        );
    });
}

#[test]
fn migration_preserves_existing_workspace_and_documents() {
    tauri::async_runtime::block_on(async {
        let pool = crate::test_support::memory_pool().await;
        migrator(3).await.run(&pool).await.unwrap();
        let workspace = active_workspace(&pool).await.unwrap();
        let document = crate::documents::create(&pool, &workspace.id, Some("Existing draft"))
            .await
            .unwrap();

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
        assert!(list(&pool, &workspace.id).await.unwrap().is_empty());
        create(&pool, &workspace.id, input("New")).await.unwrap();
    });
}
