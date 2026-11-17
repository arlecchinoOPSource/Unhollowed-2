//! Cross-feature acceptance against real, disposable SQLite files.

use crate::{
    document_links::{self, Owner},
    documents, issues, labels, milestones, overview, relationships, saved_views,
    test_support::{
        add_issue, add_issue_before_upgrade, add_project, add_workspace, migrator, TempDatabase,
        DEFAULT_WORKSPACE, OTHER_WORKSPACE,
    },
};

const RICH_TEXT: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Release notes"}]}]}"#;

async fn workspace_journey(fixture_name: &str, upgrade: bool) {
    let fixture = TempDatabase::new(fixture_name);
    let workspace = DEFAULT_WORKSPACE;
    let db = fixture.open().await;
    let latest = migrator(i64::MAX).await;
    if upgrade {
        migrator(5).await.run(&db).await.unwrap();
    } else {
        latest.run(&db).await.unwrap();
    }

    let project = add_project(&db, workspace, "Release").await;
    let document = documents::create(&db, workspace, Some("Notes"))
        .await
        .unwrap();
    let document = documents::update(&db, workspace, &document.id, "Launch notes", RICH_TEXT)
        .await
        .unwrap();
    let parent = if upgrade {
        add_issue_before_upgrade(&db, workspace, Some(&project)).await
    } else {
        add_issue(&db, workspace, Some(&project)).await
    };
    db.close().await;
    let db = fixture.open().await;
    latest.run(&db).await.unwrap();
    assert_eq!(
        documents::get(&db, workspace, &document.id).await.unwrap(),
        document
    );
    assert_eq!(
        issues::get(&db, workspace, &parent)
            .await
            .unwrap()
            .summary
            .number,
        1
    );

    let child = add_issue(&db, workspace, Some(&project)).await;
    issues::update(
        &db,
        workspace,
        &child,
        issues::IssueFields {
            title: "Publish the brief".into(),
            description: Some(RICH_TEXT.into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    relationships::add(
        &db,
        workspace,
        &child,
        &parent,
        relationships::RelationKind::Parent,
    )
    .await
    .unwrap();
    let label = labels::create(
        &db,
        workspace,
        labels::LabelInput {
            name: "Launch".into(),
            description: None,
            color: "teal".into(),
        },
    )
    .await
    .unwrap();
    let milestone = milestones::create(
        &db,
        workspace,
        milestones::MilestoneInput {
            title: "Ship".into(),
            ..Default::default()
        },
        Some(&project),
    )
    .await
    .unwrap();
    issues::set_labels(&db, workspace, &child, vec![label.id.clone()])
        .await
        .unwrap();
    issues::set_milestone(&db, workspace, &child, Some(&milestone.id))
        .await
        .unwrap();
    document_links::link(&db, workspace, Owner::Issue, &child, &document.id)
        .await
        .unwrap();
    document_links::link(&db, workspace, Owner::Project, &project, &document.id)
        .await
        .unwrap();
    let view = saved_views::create(
        &db,
        workspace,
        "Launch board",
        saved_views::ViewConfig {
            version: 1,
            view: "board".into(),
            filters: saved_views::ViewFilters {
                project: project.clone(),
                labels: vec![label.id.clone()],
                ..Default::default()
            },
        },
    )
    .await
    .unwrap();

    issues::set_status(&db, workspace, &child, "done")
        .await
        .unwrap();
    let dashboard = overview::overview(&db, workspace, &project, "2026-11-17")
        .await
        .unwrap();
    assert_eq!(
        (dashboard.total, dashboard.open, dashboard.closed),
        (2, 1, 1)
    );
    assert_eq!(dashboard.milestones[0].completed_count, 1);
    issues::reopen(&db, workspace, &child).await.unwrap();
    issues::set_archived(&db, workspace, &child, true)
        .await
        .unwrap();
    db.close().await;

    let db = fixture.open().await;
    latest.run(&db).await.unwrap();
    add_workspace(&db, OTHER_WORKSPACE, "Separate").await;
    assert!(matches!(
        issues::get(&db, OTHER_WORKSPACE, &child).await,
        Err(issues::IssueError::NotFound)
    ));
    assert!(saved_views::list(&db, OTHER_WORKSPACE)
        .await
        .unwrap()
        .is_empty());
    assert!(
        document_links::linked(&db, OTHER_WORKSPACE, Owner::Issue, &child)
            .await
            .is_err()
    );
    let archived = issues::get(&db, workspace, &child).await.unwrap();
    assert!(archived.summary.archived_at.is_some());
    assert_eq!(archived.summary.title, "Publish the brief");
    assert_eq!(archived.summary.status, "todo");
    assert_eq!(archived.summary.completed_at, None);
    assert_eq!(archived.description, RICH_TEXT);
    assert_eq!(archived.summary.milestone_id.as_ref(), Some(&milestone.id));
    assert_eq!(archived.summary.label_ids.0, vec![label.id]);
    assert_eq!(
        relationships::list(&db, workspace, &parent)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        saved_views::get(&db, workspace, &view.id).await.unwrap(),
        view
    );
    for (owner, id) in [(Owner::Issue, &child), (Owner::Project, &project)] {
        let linked = document_links::linked(&db, workspace, owner, id)
            .await
            .unwrap();
        assert_eq!(linked[0].id, document.id);
    }
    assert_eq!(
        documents::get(&db, workspace, &document.id).await.unwrap(),
        document
    );

    issues::set_archived(&db, workspace, &child, false)
        .await
        .unwrap();
    let dashboard = overview::overview(&db, workspace, &project, "2026-11-17")
        .await
        .unwrap();
    assert_eq!(
        (dashboard.total, dashboard.open, dashboard.closed),
        (2, 2, 0)
    );
    assert_eq!(dashboard.milestones[0].open_count, 1);
    db.close().await;
}

#[test]
fn fresh_database_survives_the_workspace_journey() {
    tauri::async_runtime::block_on(workspace_journey("acceptance-fresh", false));
}

#[test]
fn upgraded_database_survives_the_workspace_journey() {
    tauri::async_runtime::block_on(workspace_journey("acceptance-upgrade", true));
}
