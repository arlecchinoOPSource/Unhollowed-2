use super::*;
use crate::test_support::{
    add_workspace, memory_pool, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE,
    OTHER_WORKSPACE,
};

fn config(filters: ViewFilters) -> ViewConfig {
    ViewConfig {
        version: CONFIG_VERSION,
        view: "list".into(),
        filters,
    }
}

fn overdue_high() -> ViewConfig {
    config(ViewFilters {
        state: "open".into(),
        priority: "high".into(),
        due: "overdue".into(),
        labels: vec!["label-1".into(), "label-2".into()],
        label_match: "all".into(),
        sort: "due".into(),
        direction: "asc".into(),
        ..ViewFilters::default()
    })
}

#[test]
fn creates_renames_edits_and_removes_views_that_persist() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("saved-views");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let view = create(&pool, DEFAULT_WORKSPACE, "  Overdue work ", overdue_high())
            .await
            .unwrap();
        assert_eq!(view.name, "Overdue work");
        // Relative rules are stored as written, never as resolved dates.
        assert_eq!(view.config.filters.due, "overdue");
        let (stored,): (String,) = sqlx::query_as("SELECT config FROM saved_views")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(stored.contains("\"due\":\"overdue\""));
        assert!(!stored.contains("2026-"));
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert_eq!(get(&pool, DEFAULT_WORKSPACE, &view.id).await.unwrap(), view);

        let mut board = overdue_high();
        board.view = "board".into();
        board.filters.project = "inbox".into();
        let edited = update(
            &pool,
            DEFAULT_WORKSPACE,
            &view.id,
            "Late inbox",
            board.clone(),
        )
        .await
        .unwrap();
        assert_eq!(edited.id, view.id);
        assert_eq!(edited.name, "Late inbox");
        assert_eq!(edited.config, board);
        assert_eq!(edited.created_at, view.created_at);
        assert_eq!(list(&pool, DEFAULT_WORKSPACE).await.unwrap(), vec![edited]);

        remove(&pool, DEFAULT_WORKSPACE, &view.id).await.unwrap();
        assert_eq!(
            remove(&pool, DEFAULT_WORKSPACE, &view.id).await,
            Err(ViewError::NotFound)
        );
        assert!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().is_empty());
        pool.close().await;
    });
}

#[test]
fn rejects_duplicate_names_unsupported_versions_and_invalid_filters() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let view = create(&pool, DEFAULT_WORKSPACE, "Mine", overdue_high())
            .await
            .unwrap();
        assert_eq!(
            create(&pool, DEFAULT_WORKSPACE, " MINE ", overdue_high()).await,
            Err(ViewError::DuplicateName)
        );
        // Another workspace can reuse the name but cannot see the view.
        create(&pool, OTHER_WORKSPACE, "Mine", overdue_high())
            .await
            .unwrap();
        assert_eq!(
            get(&pool, OTHER_WORKSPACE, &view.id).await,
            Err(ViewError::NotFound)
        );
        assert_eq!(
            update(&pool, OTHER_WORKSPACE, &view.id, "Taken", overdue_high()).await,
            Err(ViewError::NotFound)
        );
        assert_eq!(
            remove(&pool, OTHER_WORKSPACE, &view.id).await,
            Err(ViewError::NotFound)
        );

        for name in ["  ", &"x".repeat(81)] {
            assert_eq!(
                create(&pool, DEFAULT_WORKSPACE, name, overdue_high()).await,
                Err(ViewError::InvalidName)
            );
        }
        let invalid = [
            ViewConfig {
                version: 2,
                ..overdue_high()
            },
            ViewConfig {
                view: "calendar".into(),
                ..overdue_high()
            },
            config(ViewFilters {
                due: "2026-11-16".into(),
                ..ViewFilters::default()
            }),
            config(ViewFilters {
                status: "closed".into(),
                ..ViewFilters::default()
            }),
            config(ViewFilters {
                sort: "rank".into(),
                ..ViewFilters::default()
            }),
            config(ViewFilters {
                labels: vec!["".into()],
                ..ViewFilters::default()
            }),
            config(ViewFilters {
                project: "a,b".into(),
                ..ViewFilters::default()
            }),
        ];
        for bad in invalid {
            assert_eq!(
                create(&pool, DEFAULT_WORKSPACE, "Bad", bad.clone()).await,
                Err(ViewError::InvalidConfig)
            );
            assert_eq!(
                update(&pool, DEFAULT_WORKSPACE, &view.id, "Mine", bad).await,
                Err(ViewError::InvalidConfig)
            );
        }
        // Unknown fields are rejected when the webview sends them.
        let unknown: Result<ViewConfig, _> =
            serde_json::from_str(r#"{"version":1,"view":"list","filters":{"color":"red"}}"#);
        assert!(unknown.is_err());
        assert_eq!(get(&pool, DEFAULT_WORKSPACE, &view.id).await.unwrap(), view);
    });
}

#[test]
fn an_unreadable_stored_view_does_not_hide_the_others() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let good = create(&pool, DEFAULT_WORKSPACE, "Good", overdue_high())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO saved_views (id, workspace_id, name, name_key, config_version, config)
             VALUES ('future', ?, 'Future', 'future', 9, '{\"version\":9}')",
        )
        .bind(DEFAULT_WORKSPACE)
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(list(&pool, DEFAULT_WORKSPACE).await.unwrap(), vec![good]);
        assert_eq!(
            get(&pool, DEFAULT_WORKSPACE, "future").await,
            Err(ViewError::InvalidConfig)
        );
    });
}

#[test]
fn upgrading_adds_an_empty_view_list() {
    tauri::async_runtime::block_on(async {
        let pool = memory_pool().await;
        migrator(11).await.run(&pool).await.unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().is_empty());
        create(&pool, DEFAULT_WORKSPACE, "First", overdue_high())
            .await
            .unwrap();
    });
}
