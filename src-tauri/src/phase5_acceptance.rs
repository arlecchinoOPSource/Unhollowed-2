//! Phase 5 acceptance on disposable file databases: upgrade a database from
//! before dashboards, save and switch dashboard layouts, change the records
//! the analytics read (complete an issue, edit a deadline, archive, check a
//! habit, record a mood, move an event), restart, and check workspace
//! isolation. Every analytics value is worked out by hand from the source
//! records below and asserted. docs/PHASE_5.md records the results.

use crate::analytics::{progress::progress, workspace_analytics, WorkspaceAnalytics};
use crate::checkins;
use crate::dashboards::{self, DashboardError};
use crate::habits;
use crate::issues::{self, IssueFields};
use crate::projects::valid_date;
use crate::scheduling::{create_event, events, EventInput};
use crate::test_support::{
    add_issue_before_upgrade, add_project, add_workspace, migrator, TempDatabase,
    DEFAULT_WORKSPACE, OTHER_WORKSPACE,
};
use serde_json::{json, Value};
use sqlx::SqlitePool;

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";
const ZONE: &str = "Europe/Paris";

async fn open(database: &TempDatabase) -> SqlitePool {
    let pool = database.open().await;
    migrator(i64::MAX).await.run(&pool).await.unwrap();
    pool
}

async fn dashboard(pool: &SqlitePool) -> WorkspaceAnalytics {
    workspace_analytics(pool, WS, "2026-11-01", "2026-11-30", None, ZONE, TODAY)
        .await
        .unwrap()
}

fn widget(id: &str, kind: &str, config: Value, y: i64) -> Value {
    json!({"id": id, "type": kind, "version": 1, "config": config, "hidden": false,
           "x": 0, "y": y, "w": 12, "h": 3})
}

fn layout(widgets: Vec<Value>) -> Value {
    json!({
        "version": 1,
        "preferences": {"preset": "last30", "custom": {"from": "2026-10-19", "to": "2026-11-17"}},
        "widgets": widgets
    })
}

fn issue(title: &str, due: &str) -> IssueFields {
    IssueFields {
        title: title.into(),
        description: None,
        priority: None,
        start_date: None,
        due_date: Some(due.into()),
    }
}

#[test]
fn upgrade_layouts_records_and_restart_keep_supported_data_and_recompute_the_same_analytics() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("phase5-acceptance");
        let pool = database.open().await;

        // Upgrade: a version 28 database (before dashboards) with an issue
        // due November 20 and a saved view.
        migrator(28).await.run(&pool).await.unwrap();
        let studio = add_project(&pool, WS, "Studio").await;
        let legacy = add_issue_before_upgrade(&pool, WS, Some(&studio)).await;
        sqlx::query("UPDATE issues SET due_date = '2026-11-20' WHERE id = ?")
            .bind(&legacy)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO saved_views (id, workspace_id, name, name_key, config_version, config)
             VALUES ('v1', ?, 'Mine', 'mine', 1, '{}')",
        )
        .bind(WS)
        .execute(&pool)
        .await
        .unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        assert!(dashboards::list(&pool, WS).await.unwrap().is_empty());
        let (views,): (i64,) = sqlx::query_as("SELECT count(*) FROM saved_views")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(views, 1);

        // Layouts: two dashboards, one with a widget type this build does not
        // know, switch the default, and a layout from a newer release.
        let general = dashboards::save(
            &pool,
            WS,
            None,
            "General Productivity",
            layout(vec![
                widget("stat-card-1", "stat-card", json!(null), 0),
                widget("notes-1", "notes", json!({"text": "Remember"}), 3),
            ]),
        )
        .await
        .unwrap();
        let school = dashboards::save(
            &pool,
            WS,
            None,
            "Student Workspace",
            layout(vec![
                widget("comparison-1", "comparison", json!({"grain": "week"}), 0),
                widget("later-1", "from-the-future", json!({"a": 1}), 3),
            ]),
        )
        .await
        .unwrap();
        dashboards::set_default(&pool, WS, &school.id)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO dashboards (id, workspace_id, name, name_key, position, layout_version, layout)
             VALUES ('f1', ?, 'Future', 'future', 9, 2, '{\"version\":2}')",
        )
        .bind(WS)
        .execute(&pool)
        .await
        .unwrap();
        let names =
            |list: Vec<dashboards::Dashboard>| list.into_iter().map(|d| d.name).collect::<Vec<_>>();
        assert_eq!(
            names(dashboards::list(&pool, WS).await.unwrap()),
            ["Student Workspace", "General Productivity", "Future"]
        );
        assert_eq!(
            dashboards::save(&pool, WS, Some("f1"), "Future", layout(vec![])).await,
            Err(DashboardError::NewerLayout)
        );

        // Records. Source of truth for every number below:
        //   issues (not archived): Legacy due 20 todo; Overdue due 12 todo;
        //   Today due 17 todo; Later due 25 todo; Dropped due 14 canceled.
        //   Archived (due 13) is never counted.
        let overdue = issues::create(&pool, WS, issue("Overdue", "2026-11-12"), None)
            .await
            .unwrap();
        let today = issues::create(&pool, WS, issue("Today", "2026-11-17"), None)
            .await
            .unwrap();
        issues::create(&pool, WS, issue("Later", "2026-11-25"), None)
            .await
            .unwrap();
        let dropped = issues::create(&pool, WS, issue("Dropped", "2026-11-14"), None)
            .await
            .unwrap();
        issues::set_status_on(&pool, WS, &dropped.summary.id, "canceled", Some(TODAY))
            .await
            .unwrap();
        let hidden = issues::create(&pool, WS, issue("Archived", "2026-11-13"), None)
            .await
            .unwrap();
        issues::set_archived(&pool, WS, &hidden.summary.id, true)
            .await
            .unwrap();

        let walk = habits::create(&pool, WS, "Walk", Some("2026-11-10"), TODAY)
            .await
            .unwrap();
        for day in ["2026-11-15", "2026-11-16", "2026-11-17"] {
            habits::set_completion(&pool, WS, &walk.id, day, true, TODAY)
                .await
                .unwrap();
        }
        checkins::save(&pool, WS, TODAY, Some(4), None, None, None, TODAY)
            .await
            .unwrap();
        let meeting = |start: &str, end: &str| EventInput {
            title: "Review".into(),
            time_zone: Some(ZONE.into()),
            start: Some(start.into()),
            end: Some(end.into()),
            ..Default::default()
        };
        let review = create_event(&pool, WS, meeting("2026-11-19T10:00", "2026-11-19T11:00"))
            .await
            .unwrap();

        let first = dashboard(&pool).await;
        let i = first.issues.data.as_ref().unwrap();
        // Open: Legacy, Overdue, Today, Later. Overdue: just the 12th. Due in
        // the period and not canceled: Legacy, Overdue, Today, Later.
        assert_eq!((i.open, i.overdue, i.due, i.due_completed), (4, 1, 4, 0));
        let h = first.habits.data.as_ref().unwrap();
        // Walk is eligible November 10 to 17: 8 days, 3 done.
        assert_eq!((h.eligible, h.completed, h.percent), (8, 3, Some(37.5)));
        let m = first.mood.data.as_ref().unwrap();
        assert_eq!(
            (m.days_recorded, m.mood.samples, m.mood.average),
            (1, 1, Some(4.0))
        );
        let c = first.calendar.data.as_ref().unwrap();
        assert_eq!((c.events, c.scheduled_minutes), (1, 60));

        // Edits: complete an issue, move a deadline, reschedule the event.
        issues::set_status_on(&pool, WS, &today.summary.id, "done", Some(TODAY))
            .await
            .unwrap();
        issues::set_due_date(&pool, WS, &overdue.summary.id, Some("2026-11-24"))
            .await
            .unwrap();
        events::update(
            &pool,
            WS,
            &review.id,
            meeting("2026-11-20T14:00", "2026-11-20T16:00"),
        )
        .await
        .unwrap();
        let second = dashboard(&pool).await;
        let i = second.issues.data.as_ref().unwrap();
        // Open: Legacy, Overdue (now due 24th), Later. Nothing is overdue.
        // Due, not canceled: still 4; one of them (Today) is done.
        assert_eq!((i.open, i.overdue, i.due, i.due_completed), (3, 0, 4, 1));
        assert_eq!(i.due_percent, Some(25.0));
        let c = second.calendar.data.as_ref().unwrap();
        assert_eq!((c.events, c.scheduled_minutes), (1, 120));
        let by_project = progress(
            &pool,
            WS,
            "2026-11-01",
            "2026-11-30",
            Some(&studio),
            ZONE,
            TODAY,
        )
        .await
        .unwrap();
        // The filter keeps only the upgraded issue (open, due the 20th).
        assert_eq!(
            (
                by_project.totals.total,
                by_project.totals.open,
                by_project.totals.overdue
            ),
            (1, 1, 0)
        );

        // Isolation: another workspace sees none of it.
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        assert!(dashboards::list(&pool, OTHER_WORKSPACE)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            dashboards::set_default(&pool, OTHER_WORKSPACE, &general.id).await,
            Err(DashboardError::NotFound)
        );
        let other = workspace_analytics(
            &pool,
            OTHER_WORKSPACE,
            "2026-11-01",
            "2026-11-30",
            None,
            ZONE,
            TODAY,
        )
        .await
        .unwrap();
        let other_issues = other.issues.data.unwrap();
        assert_eq!((other_issues.open, other_issues.due), (0, 0));
        let before_restart = names(dashboards::list(&pool, WS).await.unwrap());
        let layouts_before: Vec<Value> = dashboards::list(&pool, WS)
            .await
            .unwrap()
            .into_iter()
            .map(|d| d.layout)
            .collect();
        pool.close().await;

        // Restart: layouts, the unknown widget, the newer layout, and the
        // default survive, and the analytics recompute to the same values.
        let pool = open(&database).await;
        let listed = dashboards::list(&pool, WS).await.unwrap();
        assert_eq!(
            names(listed.iter().map(clone_dashboard).collect()),
            before_restart
        );
        assert_eq!(
            listed.iter().map(|d| d.layout.clone()).collect::<Vec<_>>(),
            layouts_before
        );
        let school_back = &listed[0];
        assert_eq!(school_back.layout["widgets"][1]["type"], "from-the-future");
        assert_eq!(school_back.layout["widgets"][1]["config"], json!({"a": 1}));
        assert_eq!(listed[2].layout_version, 2);
        let again = dashboard(&pool).await;
        let i = again.issues.data.as_ref().unwrap();
        assert_eq!((i.open, i.overdue, i.due, i.due_completed), (3, 0, 4, 1));
        assert_eq!(again.habits.data.as_ref().unwrap().completed, 3);
        assert_eq!(again.calendar.data.as_ref().unwrap().scheduled_minutes, 120);
        assert!(valid_date("2026-11-17"));
        pool.close().await;
    });
}

fn clone_dashboard(d: &dashboards::Dashboard) -> dashboards::Dashboard {
    dashboards::Dashboard {
        id: d.id.clone(),
        name: d.name.clone(),
        position: d.position,
        layout_version: d.layout_version,
        layout: d.layout.clone(),
        created_at: d.created_at.clone(),
        updated_at: d.updated_at.clone(),
    }
}
