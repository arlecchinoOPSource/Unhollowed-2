//! The beta acceptance journey (U2-P6-09): one workspace is built through
//! every main productivity system on a real SQLite file, the database is
//! closed and reopened (an application restart), and every record and
//! every dashboard number must be the same. No interface is mocked: these
//! are the functions the Tauri commands call. docs/ACCEPTANCE.md records the
//! results and what this does not cover.

use crate::analytics::workspace_analytics;
use crate::document_links::{self, Owner};
use crate::documents;
use crate::issues::{self, IssueFields};
use crate::milestones::{self, MilestoneInput};
use crate::scheduling::{
    create_event, create_work_block, recurrence::RepeatRule, EventInput, WorkBlockInput,
};
use crate::test_support::{add_project, migrator, TempDatabase, DEFAULT_WORKSPACE};
use crate::{checkins, habits};
use sqlx::SqlitePool;

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";
const ZONE: &str = "Europe/Paris";
const FORMATTED: &str = r#"{"type":"doc","attrs":{"schemaVersion":1},"content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Launch plan"}]},{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"},{"type":"italic"}],"text":"Ship it"}]}]}"#;

async fn open(database: &TempDatabase) -> SqlitePool {
    let pool = database.open().await;
    migrator(i64::MAX).await.run(&pool).await.unwrap();
    pool
}

/// Everything a person can see on the dashboard for the week, as one value.
async fn dashboard(pool: &SqlitePool) -> String {
    let all = workspace_analytics(pool, WS, "2026-11-16", "2026-11-22", None, ZONE, TODAY)
        .await
        .unwrap();
    serde_json::to_string(&all).unwrap()
}

#[test]
fn a_workspace_built_through_every_system_is_the_same_after_a_restart() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("beta-workflow");
        let pool = open(&database).await;

        // 1-3. Project, issues with priorities, a milestone.
        let project = add_project(&pool, WS, "Launch").await;
        let milestone = milestones::create(
            &pool,
            WS,
            MilestoneInput {
                title: "Beta".into(),
                description: None,
                due_date: Some("2026-11-20".into()),
            },
            Some(&project),
        )
        .await
        .unwrap();
        let mut ids = Vec::new();
        for (title, priority) in [
            ("Write copy", "high"),
            ("Fix bug", "urgent"),
            ("Polish", "low"),
        ] {
            let issue = issues::create(
                &pool,
                WS,
                IssueFields {
                    title: title.into(),
                    description: None,
                    priority: Some(priority.into()),
                    start_date: None,
                    due_date: Some("2026-11-18".into()),
                },
                Some(&project),
            )
            .await
            .unwrap();
            issues::set_milestone(&pool, WS, &issue.summary.id, Some(&milestone.id))
                .await
                .unwrap();
            ids.push(issue.summary.id);
        }

        // 4-6. A formatted document, linked to the project and an issue.
        let document = documents::create(&pool, WS, Some("Plan")).await.unwrap();
        let document = documents::update(&pool, WS, &document.id, "Launch plan", FORMATTED)
            .await
            .unwrap();
        document_links::link(&pool, WS, Owner::Project, &project, &document.id)
            .await
            .unwrap();
        document_links::link(&pool, WS, Owner::Issue, &ids[0], &document.id)
            .await
            .unwrap();

        // 7-8. Scheduled work and a recurring event.
        create_work_block(
            &pool,
            WS,
            WorkBlockInput {
                issue_id: ids[0].clone(),
                time_zone: ZONE.into(),
                start: "2026-11-18T10:00".into(),
                end: "2026-11-18T11:30".into(),
            },
        )
        .await
        .unwrap();
        create_event(
            &pool,
            WS,
            EventInput {
                title: "Standup".into(),
                time_zone: Some(ZONE.into()),
                start: Some("2026-11-17T09:00".into()),
                end: Some("2026-11-17T09:15".into()),
                repeat: Some(RepeatRule {
                    freq: "daily".into(),
                    interval: 1,
                    count: Some(5),
                    until: None,
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        // 9-11. A habit with completions and a mood check-in.
        let habit = habits::create(&pool, WS, "Walk", Some("2026-11-16"), TODAY)
            .await
            .unwrap();
        for day in ["2026-11-16", "2026-11-17"] {
            habits::set_completion(&pool, WS, &habit.id, day, true, TODAY)
                .await
                .unwrap();
        }
        checkins::save(
            &pool,
            WS,
            TODAY,
            Some(4),
            Some(3),
            Some(5),
            Some("Steady"),
            TODAY,
        )
        .await
        .unwrap();

        // 12-13. Complete issues; the dashboard follows each commit.
        let before = dashboard(&pool).await;
        issues::set_status_on(&pool, WS, &ids[0], "done", Some(TODAY))
            .await
            .unwrap();
        issues::set_status_on(&pool, WS, &ids[1], "done", Some(TODAY))
            .await
            .unwrap();
        let after = dashboard(&pool).await;
        assert_ne!(before, after, "completing issues must change the dashboard");
        let value: serde_json::Value = serde_json::from_str(&after).unwrap();
        let section = |name: &str| value[name]["data"].clone();
        assert_eq!(section("issues")["open"], 1);
        assert_eq!(section("issues")["due"], 3);
        assert_eq!(section("issues")["dueCompleted"], 2);
        assert_eq!(section("habits")["completed"], 2);
        assert_eq!(section("mood")["daysRecorded"], 1);
        assert_eq!(section("calendar")["workBlocks"], 1);
        assert!(section("calendar")["events"].as_i64().unwrap() >= 5);
        assert_eq!(section("milestones")["open"], 1);

        // 14. Restart: close the file and open it again from disk.
        let issue_rows = rows(
            &pool,
            "SELECT id || status || priority || ifnull(milestone_id,'') FROM issues ORDER BY id",
        )
        .await;
        pool.close().await;
        let pool = open(&database).await;

        // 15. The workspace is intact: same dashboard, same records.
        assert_eq!(dashboard(&pool).await, after);
        assert_eq!(
            rows(&pool, "SELECT id || status || priority || ifnull(milestone_id,'') FROM issues ORDER BY id").await,
            issue_rows
        );
        assert_eq!(
            documents::get(&pool, WS, &document.id)
                .await
                .unwrap()
                .content,
            FORMATTED
        );
        for (owner, id) in [(Owner::Project, &project), (Owner::Issue, &ids[0])] {
            let linked = document_links::linked(&pool, WS, owner, id).await.unwrap();
            assert_eq!(linked.len(), 1);
            assert_eq!(linked[0].id, document.id);
        }
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
        // Running the migrations again on the reopened file adds nothing.
        for table in [
            "issues",
            "documents",
            "events",
            "habits",
            "habit_completions",
            "daily_checkins",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
            let expected = match table {
                "issues" => 3,
                "documents" => 1,
                "events" => 1,
                "habits" => 1,
                "habit_completions" => 2,
                _ => 1,
            };
            assert_eq!(count, expected, "{table} after restart");
        }
    });
}

async fn rows(pool: &SqlitePool, sql: &str) -> Vec<String> {
    sqlx::query_scalar(sql).fetch_all(pool).await.unwrap()
}
