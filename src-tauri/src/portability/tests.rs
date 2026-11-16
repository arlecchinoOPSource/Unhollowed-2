use super::*;
use crate::issues::{create, set_archived, set_labels, set_milestone, set_status, IssueFields};
use crate::relationships::{add, RelationKind};
use crate::test_support::{
    add_project, add_workspace, migrated_pool, DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};

const RICH: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Keep me"}]}]}"#;

async fn issue(pool: &SqlitePool, workspace: &str, title: &str, project: Option<&str>) -> String {
    create(
        pool,
        workspace,
        IssueFields {
            title: title.into(),
            description: Some(RICH.into()),
            priority: Some("high".into()),
            due_date: Some("2026-12-01".into()),
            ..IssueFields::default()
        },
        project,
    )
    .await
    .unwrap()
    .summary
    .id
}

/// A workspace with every supported record and relationship.
async fn sample(pool: &SqlitePool) {
    let project = add_project(pool, DEFAULT_WORKSPACE, "Launch").await;
    let first = issue(pool, DEFAULT_WORKSPACE, "Plan", Some(&project)).await;
    let second = issue(
        pool,
        DEFAULT_WORKSPACE,
        "Print, \"posters\"",
        Some(&project),
    )
    .await;
    let third = issue(pool, DEFAULT_WORKSPACE, "Inbox note", None).await;
    add(
        pool,
        DEFAULT_WORKSPACE,
        &second,
        &first,
        RelationKind::Parent,
    )
    .await
    .unwrap();
    add(
        pool,
        DEFAULT_WORKSPACE,
        &third,
        &first,
        RelationKind::Blocks,
    )
    .await
    .unwrap();
    add(
        pool,
        DEFAULT_WORKSPACE,
        &third,
        &second,
        RelationKind::Related,
    )
    .await
    .unwrap();
    let mut label_ids = Vec::new();
    for (name, archived) in [("Bug", false), ("Old", true)] {
        let label = crate::labels::create(
            pool,
            DEFAULT_WORKSPACE,
            crate::labels::LabelInput {
                name: name.into(),
                description: None,
                color: "red".into(),
            },
        )
        .await
        .unwrap();
        label_ids.push((label.id, archived));
    }
    // Labels replace as a set, and archived labels cannot be newly linked.
    set_labels(
        pool,
        DEFAULT_WORKSPACE,
        &first,
        label_ids.iter().map(|(id, _)| id.clone()).collect(),
    )
    .await
    .unwrap();
    for (id, _) in label_ids.iter().filter(|(_, archived)| *archived) {
        crate::labels::set_archived(pool, DEFAULT_WORKSPACE, id, true)
            .await
            .unwrap();
    }
    let milestone = crate::milestones::create(
        pool,
        DEFAULT_WORKSPACE,
        crate::milestones::MilestoneInput {
            title: "Beta".into(),
            ..Default::default()
        },
        Some(&project),
    )
    .await
    .unwrap();
    set_milestone(pool, DEFAULT_WORKSPACE, &first, Some(&milestone.id))
        .await
        .unwrap();
    set_status(pool, DEFAULT_WORKSPACE, &second, "done")
        .await
        .unwrap();
    set_archived(pool, DEFAULT_WORKSPACE, &third, true)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO missions (id, project_id, title, description) VALUES ('m1', ?, 'Ship', '')",
    )
    .bind(&project)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO objectives (id, project_id, mission_id, title, description)
         VALUES ('o1', ?, 'm1', 'Print it', '')",
    )
    .bind(&project)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO objective_issues (objective_id, issue_id) VALUES ('o1', ?)")
        .bind(&second)
        .execute(pool)
        .await
        .unwrap();
}

/// The data with IDs, numbers, and timestamps removed, for comparison.
fn shape(data: &ProjectData) -> serde_json::Value {
    let issue_titles: HashMap<&str, &str> = data
        .issues
        .iter()
        .map(|i| (i.id.as_str(), i.title.as_str()))
        .collect();
    let mut relationships: Vec<_> = data
        .relationships
        .iter()
        .map(|r| {
            let (a, b) = (
                issue_titles[r.source_id.as_str()],
                issue_titles[r.target_id.as_str()],
            );
            let (a, b) = if r.kind == "related" && a > b {
                (b, a)
            } else {
                (a, b)
            };
            (r.kind.clone(), a.to_owned(), b.to_owned())
        })
        .collect();
    relationships.sort();
    let mut issues: Vec<_> = data
        .issues
        .iter()
        .map(|i| {
            serde_json::json!([
                i.title,
                i.description,
                i.status,
                i.priority,
                i.due_date,
                i.archived,
                i.project_id.is_some(),
                i.milestone_id.is_some(),
                i.completed_at.is_some()
            ])
        })
        .collect();
    issues.sort_by_key(|value| value.to_string());
    serde_json::json!({
        "projects": data.projects.iter().map(|p| &p.name).collect::<Vec<_>>(),
        "labels": data.labels.iter().map(|l| (&l.name, l.archived)).collect::<Vec<_>>(),
        "milestones": data.milestones.iter().map(|m| &m.title).collect::<Vec<_>>(),
        "missions": data.missions.len(),
        "objectives": data.objectives.len(),
        "issues": issues,
        "issueLabels": data.issue_labels.len(),
        "objectiveIssues": data.objective_issues.len(),
        "relationships": relationships,
    })
}

#[test]
fn round_trips_every_supported_record_into_another_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        sample(&pool).await;
        let original = export(&pool, DEFAULT_WORKSPACE).await.unwrap();
        assert_eq!(original.format, FORMAT);
        assert_eq!(original.version, VERSION);
        assert_eq!(original.issues.len(), 3);
        let json = serde_json::to_string(&original).unwrap();

        let report = import(&pool, OTHER_WORKSPACE, &json, true).await.unwrap();
        assert_eq!(
            (report.projects, report.issues, report.relationships),
            (1, 3, 3)
        );
        assert_eq!(report.labels_created, 2);
        let copied = export(&pool, OTHER_WORKSPACE).await.unwrap();
        assert_eq!(shape(&copied), shape(&original));
        // Every ID is new.
        let old: HashSet<&str> = original.issues.iter().map(|i| i.id.as_str()).collect();
        assert!(copied.issues.iter().all(|i| !old.contains(i.id.as_str())));
        // Rich text is preserved exactly, and the copies are searchable.
        assert!(copied.issues.iter().all(|i| i.description == RICH));
        let found = crate::search::search(&pool, OTHER_WORKSPACE, "keep me")
            .await
            .unwrap();
        assert_eq!(found.issue_total, 2);
    });
}

#[test]
fn importing_into_the_same_workspace_copies_renumbers_and_reuses_labels() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        sample(&pool).await;
        let json = serde_json::to_string(&export(&pool, DEFAULT_WORKSPACE).await.unwrap()).unwrap();

        // The preview reports exactly what the import does and writes nothing.
        let preview = import(&pool, DEFAULT_WORKSPACE, &json, false)
            .await
            .unwrap();
        assert_eq!(
            export(&pool, DEFAULT_WORKSPACE).await.unwrap().issues.len(),
            3
        );
        let report = import(&pool, DEFAULT_WORKSPACE, &json, true).await.unwrap();
        assert_eq!(preview, report);

        assert_eq!(report.labels_reused, ["Bug", "Old"]);
        assert_eq!(report.labels_created, 0);
        // The issue linked to the archived "Old" label skips that link.
        assert_eq!(report.skipped_label_links, 1);
        assert_eq!(
            report.renumbered,
            [
                ("ISS-1".to_owned(), "ISS-4".to_owned()),
                ("ISS-2".to_owned(), "ISS-5".to_owned()),
                ("ISS-3".to_owned(), "ISS-6".to_owned()),
            ]
        );
        let after = export(&pool, DEFAULT_WORKSPACE).await.unwrap();
        assert_eq!(after.issues.len(), 6);
        assert_eq!(after.projects.len(), 2);
        assert_eq!(after.labels.len(), 2);
    });
}

fn base() -> ProjectData {
    ProjectData {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: "2026-11-16T00:00:00Z".into(),
        projects: vec![],
        labels: vec![],
        milestones: vec![],
        missions: vec![],
        objectives: vec![],
        issues: vec![],
        issue_labels: vec![],
        objective_issues: vec![],
        relationships: vec![],
    }
}

fn plain_issue(id: &str, number: i64, project: Option<&str>) -> PortableIssue {
    PortableIssue {
        id: id.into(),
        number,
        project_id: project.map(Into::into),
        milestone_id: None,
        title: format!("Issue {number}"),
        description: r#"{"type":"doc"}"#.into(),
        status: "todo".into(),
        priority: "none".into(),
        start_date: None,
        due_date: None,
        completed_at: None,
        created_at: "2026-11-01T00:00:00Z".into(),
        updated_at: "2026-11-01T00:00:00Z".into(),
        archived: false,
    }
}

fn project(id: &str) -> PortableProject {
    PortableProject {
        id: id.into(),
        name: "P".into(),
        description: None,
        status: "active".into(),
        start_date: None,
        target_date: None,
        created_at: "2026-11-01T00:00:00Z".into(),
        updated_at: "2026-11-01T00:00:00Z".into(),
    }
}

fn rejected(data: &ProjectData) -> Vec<String> {
    match parse(&serde_json::to_string(data).unwrap()) {
        Err(PortError::InvalidFile { problems, .. }) => problems,
        other => panic!("expected rejection, got {other:?}"),
    }
}

#[test]
fn rejects_unsupported_files_and_unresolved_references_before_writing() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let mut wrong = base();
        wrong.format = "something-else".into();
        assert!(rejected(&wrong)[0].contains("file format"));
        let mut future = base();
        future.version = 2;
        assert!(rejected(&future)[0].contains("Version 2 files are not supported"));
        // Unknown fields and broken JSON are unreadable, with a reason.
        for content in [
            r#"{"format":"x"}"#,
            "not json",
            r#"{"format":"unhollowed-2/projects","version":1,"exportedAt":"","projects":[],"labels":[],"milestones":[],"missions":[],"objectives":[],"issues":[],"issueLabels":[],"objectiveIssues":[],"relationships":[],"extra":1}"#,
        ] {
            assert!(matches!(
                parse(content),
                Err(PortError::UnreadableFile { .. })
            ));
        }

        let mut data = base();
        data.projects = vec![project("p1"), project("p2")];
        data.milestones = vec![PortableMilestone {
            id: "m1".into(),
            project_id: Some("p2".into()),
            title: "Beta".into(),
            description: None,
            due_date: None,
            closed: false,
        }];
        let mut on_wrong_milestone = plain_issue("i1", 1, Some("p1"));
        on_wrong_milestone.milestone_id = Some("m1".into());
        let mut bad_values = plain_issue("i2", 2, None);
        bad_values.status = "closed".into();
        bad_values.description = "not json".into();
        data.issues = vec![
            on_wrong_milestone,
            bad_values,
            plain_issue("i3", 3, Some("missing")),
            plain_issue("i3", 4, None),
            plain_issue("a", 5, None),
            plain_issue("b", 6, None),
        ];
        data.issue_labels = vec![PortableIssueLabel {
            issue_id: "i1".into(),
            label_id: "nope".into(),
        }];
        data.relationships = ["parent", "parent", "parent"]
            .iter()
            .zip([("a", "b"), ("b", "a"), ("a", "i1")])
            .map(|(kind, (source, target))| PortableRelationship {
                source_id: source.into(),
                target_id: target.into(),
                kind: (*kind).into(),
            })
            .collect();
        let problems = rejected(&data);
        let text = problems.join("\n");
        for expected in [
            "milestone belongs to another project",
            "ISS-2 has invalid values",
            "refers to project missing",
            "issue ID i3 appears more than once",
            "label link",
            "more than one parent",
            "Parent relationships form a cycle",
        ] {
            assert!(
                text.contains(expected),
                "missing \"{expected}\" in:\n{text}"
            );
        }
        // Nothing was written.
        assert!(export(&pool, DEFAULT_WORKSPACE)
            .await
            .unwrap()
            .issues
            .is_empty());
        let json = serde_json::to_string(&data).unwrap();
        assert!(matches!(
            import(&pool, DEFAULT_WORKSPACE, &json, true).await,
            Err(PortError::InvalidFile { .. })
        ));
        assert!(export(&pool, DEFAULT_WORKSPACE)
            .await
            .unwrap()
            .projects
            .is_empty());

        // Long lists are truncated, with the total reported.
        let mut many = base();
        many.issues = (1..=30)
            .map(|n| plain_issue(&format!("x{n}"), n, Some("gone")))
            .collect();
        match parse(&serde_json::to_string(&many).unwrap()) {
            Err(PortError::InvalidFile { problems, total }) => {
                assert_eq!((problems.len(), total), (MAX_PROBLEMS, 30));
            }
            other => panic!("unexpected {other:?}"),
        }
    });
}

#[test]
fn a_failure_partway_through_rolls_back_the_whole_import() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        sample(&pool).await;
        let json = serde_json::to_string(&export(&pool, DEFAULT_WORKSPACE).await.unwrap()).unwrap();
        let (counter,): (i64,) = sqlx::query_as("SELECT last_number FROM issue_counters")
            .fetch_one(&pool)
            .await
            .unwrap();
        // Relationships are written last, after every other record.
        sqlx::query(
            "CREATE TEMP TRIGGER refuse BEFORE INSERT ON issue_relationships
             BEGIN SELECT RAISE(ABORT, 'refused'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            import(&pool, DEFAULT_WORKSPACE, &json, true).await,
            Err(PortError::StorageFailed)
        );
        let after = export(&pool, DEFAULT_WORKSPACE).await.unwrap();
        assert_eq!((after.projects.len(), after.issues.len()), (1, 3));
        let (unchanged,): (i64,) = sqlx::query_as("SELECT last_number FROM issue_counters")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(unchanged, counter);
    });
}

#[test]
fn repairs_completion_times_to_match_status() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let mut data = base();
        let mut done = plain_issue("d", 1, None);
        done.status = "done".into();
        let mut reopened = plain_issue("r", 2, None);
        reopened.completed_at = Some("2026-01-01T00:00:00Z".into());
        data.issues = vec![done, reopened];
        let report = import(
            &pool,
            DEFAULT_WORKSPACE,
            &serde_json::to_string(&data).unwrap(),
            true,
        )
        .await
        .unwrap();
        assert_eq!(report.completion_repaired, 1);
        let issues = export(&pool, DEFAULT_WORKSPACE).await.unwrap().issues;
        assert!(issues[0].completed_at.is_some());
        assert_eq!(issues[1].completed_at, None);
    });
}

#[test]
fn csv_fields_are_quoted_and_protected_from_formulas() {
    assert_eq!(csv_field("plain"), "plain");
    assert_eq!(csv_field("a, b"), "\"a, b\"");
    assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
    assert_eq!(csv_field("two\nlines"), "\"two\nlines\"");
    for formula in ["=SUM(A1)", "+1", "-1", "@cmd", "\tx", "  =1", "＋1"] {
        assert!(csv_field(formula).starts_with('\''), "{formula:?}");
    }
    assert_eq!(csv_field("=1,2"), "\"'=1,2\"");
}

#[test]
fn csv_export_follows_filters_and_includes_every_page() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        sample(&pool).await;
        let (csv, rows) = issues_csv(
            &pool,
            DEFAULT_WORKSPACE,
            IssueQuery {
                filter: crate::issues::IssueFilter {
                    state: Some("all".into()),
                    archived: Some("include".into()),
                    ..Default::default()
                },
                sort: Some("title".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(rows, 3);
        let lines: Vec<_> = csv.split("\r\n").collect();
        assert!(lines[0].starts_with("Key,Title,Status,Priority,Project,Milestone,Labels"));
        assert!(lines[1].starts_with("ISS-3,Inbox note,todo,high,,"));
        assert!(lines[1].ends_with(",yes"));
        assert!(lines[2].starts_with("ISS-1,Plan,todo,high,Launch,Beta,Bug; Old,"));
        assert!(lines[3].starts_with("ISS-2,\"Print, \"\"posters\"\"\",done,"));

        // More than one page of the shared query.
        for index in 0..250 {
            issue(&pool, DEFAULT_WORKSPACE, &format!("Bulk {index}"), None).await;
        }
        let (_, rows) = issues_csv(&pool, DEFAULT_WORKSPACE, IssueQuery::default())
            .await
            .unwrap();
        assert_eq!(rows, 252);
    });
}

#[test]
fn detects_cycles_in_large_import_graphs_without_recursion() {
    let ids: Vec<_> = (0..50_000).map(|i| i.to_string()).collect();
    let mut edges: HashMap<_, _> = ids
        .windows(2)
        .map(|pair| (pair[0].as_str(), vec![pair[1].as_str()]))
        .collect();
    assert!(!has_cycle(&edges));
    edges.insert(ids.last().unwrap().as_str(), vec![ids[0].as_str()]);
    assert!(has_cycle(&edges));
}
