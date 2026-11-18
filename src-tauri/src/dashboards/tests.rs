use super::*;
use crate::test_support::{
    add_workspace, memory_pool, migrated_pool, migrator, TempDatabase, DEFAULT_WORKSPACE,
    OTHER_WORKSPACE,
};
use serde_json::json;

fn widget(id: &str, kind: &str) -> Value {
    json!({"id": id, "type": kind, "version": 1, "config": {}, "hidden": false,
           "x": 0, "y": 0, "w": 12, "h": 3})
}

fn layout(widgets: Vec<Value>) -> Value {
    json!({
        "version": 1,
        "preferences": {"preset": "last30", "custom": {"from": "2026-10-20", "to": "2026-11-18"}},
        "widgets": widgets
    })
}

#[test]
fn saved_layouts_survive_a_restart_and_keep_unknown_widgets() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("dashboards");
        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let saved = save(
            &pool,
            DEFAULT_WORKSPACE,
            None,
            "  Weekly ",
            layout(vec![
                widget("glance", "stat-card"),
                widget("x1", "from-the-future"),
            ]),
        )
        .await
        .unwrap();
        assert_eq!(saved.name, "Weekly");
        assert_eq!(saved.layout_version, 1);
        pool.close().await;

        let pool = database.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let listed = list(&pool, DEFAULT_WORKSPACE).await.unwrap();
        assert_eq!(listed, vec![saved]);
        let ids: Vec<_> = listed[0].layout["widgets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["type"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids, ["stat-card", "from-the-future"]);
        pool.close().await;
    });
}

#[test]
fn updates_rename_and_replace_in_one_step_and_names_are_unique() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let a = save(&pool, DEFAULT_WORKSPACE, None, "A", layout(vec![]))
            .await
            .unwrap();
        save(&pool, DEFAULT_WORKSPACE, None, "B", layout(vec![]))
            .await
            .unwrap();
        let edited = save(
            &pool,
            DEFAULT_WORKSPACE,
            Some(&a.id),
            "A2",
            layout(vec![widget("n", "notes")]),
        )
        .await
        .unwrap();
        assert_eq!(edited.name, "A2");
        assert_eq!(edited.layout["widgets"].as_array().unwrap().len(), 1);
        assert_eq!(
            save(&pool, DEFAULT_WORKSPACE, Some(&a.id), " b ", layout(vec![])).await,
            Err(DashboardError::DuplicateName)
        );
        // The failed rename left the layout as it was.
        let again = list(&pool, DEFAULT_WORKSPACE).await.unwrap();
        assert_eq!(again[0].name, "A2");
        assert_eq!(again[0].layout["widgets"].as_array().unwrap().len(), 1);
    });
}

#[test]
fn dashboards_belong_to_one_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let mine = save(&pool, DEFAULT_WORKSPACE, None, "Mine", layout(vec![]))
            .await
            .unwrap();
        // The same name is free in another workspace.
        save(&pool, OTHER_WORKSPACE, None, "Mine", layout(vec![]))
            .await
            .unwrap();
        assert_eq!(list(&pool, OTHER_WORKSPACE).await.unwrap().len(), 1);
        assert_eq!(
            save(
                &pool,
                OTHER_WORKSPACE,
                Some(&mine.id),
                "Hijack",
                layout(vec![])
            )
            .await,
            Err(DashboardError::NotFound)
        );
        assert_eq!(
            remove(&pool, OTHER_WORKSPACE, &mine.id).await,
            Err(DashboardError::NotFound)
        );
        remove(&pool, DEFAULT_WORKSPACE, &mine.id).await.unwrap();
        assert!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().is_empty());
    });
}

#[test]
fn invalid_layouts_and_names_are_rejected_without_storing_anything() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let mut bad = vec![];
        let mut wide = widget("a", "notes");
        wide["w"] = json!(13);
        bad.push(layout(vec![wide]));
        let mut offgrid = widget("a", "notes");
        offgrid["x"] = json!(8);
        offgrid["w"] = json!(6);
        bad.push(layout(vec![offgrid]));
        bad.push(layout(vec![widget("a", "notes"), widget("a", "notes")]));
        bad.push(layout(vec![widget("Bad Id", "notes")]));
        bad.push(layout(vec![widget("a", "../etc")]));
        let mut extra = widget("a", "notes");
        extra["script"] = json!("alert(1)");
        bad.push(layout(vec![extra]));
        let mut config = widget("a", "notes");
        config["config"] = json!({"text": "x".repeat(9000)});
        bad.push(layout(vec![config]));
        let mut newer = layout(vec![]);
        newer["version"] = json!(2);
        bad.push(newer);
        let mut preset = layout(vec![]);
        preset["preferences"]["preset"] = json!("last3650");
        bad.push(preset);
        let mut day = layout(vec![]);
        day["preferences"]["custom"]["from"] = json!("2026-02-30");
        bad.push(day);
        bad.push(json!("not a layout"));
        bad.push(layout(
            (0..61).map(|i| widget(&format!("w{i}"), "notes")).collect(),
        ));
        for item in bad {
            assert_eq!(
                save(&pool, DEFAULT_WORKSPACE, None, "X", item).await,
                Err(DashboardError::InvalidLayout)
            );
        }
        for name in ["", "   ", &"n".repeat(81)] {
            assert_eq!(
                save(&pool, DEFAULT_WORKSPACE, None, name, layout(vec![])).await,
                Err(DashboardError::InvalidName)
            );
        }
        assert!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().is_empty());
    });
}

#[test]
fn a_layout_from_a_newer_release_is_returned_but_never_overwritten() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        sqlx::query(
            "INSERT INTO dashboards (id, workspace_id, name, name_key, layout_version, layout)
             VALUES ('d1', ?, 'Future', 'future', 2, '{\"version\":2,\"shiny\":true}')",
        )
        .bind(DEFAULT_WORKSPACE)
        .execute(&pool)
        .await
        .unwrap();
        let listed = list(&pool, DEFAULT_WORKSPACE).await.unwrap();
        assert_eq!(listed[0].layout_version, 2);
        assert_eq!(listed[0].layout["shiny"], json!(true));
        assert_eq!(
            save(
                &pool,
                DEFAULT_WORKSPACE,
                Some("d1"),
                "Future",
                layout(vec![])
            )
            .await,
            Err(DashboardError::NewerLayout)
        );
        let after = list(&pool, DEFAULT_WORKSPACE).await.unwrap();
        assert_eq!(after[0].layout["shiny"], json!(true));
    });
}

#[test]
fn the_workspace_holds_a_bounded_number_of_dashboards() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for i in 0..MAX_DASHBOARDS {
            save(
                &pool,
                DEFAULT_WORKSPACE,
                None,
                &format!("D{i}"),
                layout(vec![]),
            )
            .await
            .unwrap();
        }
        assert_eq!(
            save(&pool, DEFAULT_WORKSPACE, None, "One more", layout(vec![])).await,
            Err(DashboardError::TooMany)
        );
        let listed = list(&pool, DEFAULT_WORKSPACE).await.unwrap();
        assert_eq!(listed.first().unwrap().name, "D0");
    });
}

#[test]
fn upgrading_from_the_previous_schema_keeps_existing_data() {
    tauri::async_runtime::block_on(async {
        let pool = memory_pool().await;
        migrator(28).await.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO saved_views (id, workspace_id, name, name_key, config_version, config)
             VALUES ('v1', ?, 'Mine', 'mine', 1, '{}')",
        )
        .bind(DEFAULT_WORKSPACE)
        .execute(&pool)
        .await
        .unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let (views,): (i64,) = sqlx::query_as("SELECT count(*) FROM saved_views")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(views, 1);
        assert!(list(&pool, DEFAULT_WORKSPACE).await.unwrap().is_empty());
    });
}
