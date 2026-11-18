//! The Phase 5 planning-to-completion journey on a disposable file database:
//! an issue due today gets a planned work session and a linked document, is
//! completed, reopened, and the database is restarted. The same issue,
//! document, and work session must be the ones found at every step, and the
//! dashboard's numbers must follow each committed write. docs/PHASE_5.md
//! records the results.

use crate::analytics::progress::progress;
use crate::analytics::workspace_analytics;
use crate::document_links::{self, Owner};
use crate::documents;
use crate::issues::{self, IssueFields};
use crate::scheduling::{create_work_block, list_work_blocks, WorkBlockInput};
use crate::test_support::{migrator, TempDatabase, DEFAULT_WORKSPACE};
use sqlx::SqlitePool;

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";
const ZONE: &str = "Europe/Paris";

async fn open(database: &TempDatabase) -> SqlitePool {
    let pool = database.open().await;
    migrator(i64::MAX).await.run(&pool).await.unwrap();
    pool
}

#[test]
fn one_issue_document_and_work_session_carry_through_planning_completion_and_restart() {
    tauri::async_runtime::block_on(async {
        let database = TempDatabase::new("phase5-journey");
        let pool = open(&database).await;

        // Plan: an issue due today, its work session, and a linked document.
        let issue = issues::create(
            &pool,
            WS,
            IssueFields {
                title: "Book venue".into(),
                description: None,
                priority: Some("high".into()),
                start_date: None,
                due_date: Some(TODAY.into()),
            },
            None,
        )
        .await
        .unwrap();
        let id = issue.summary.id.clone();
        let document = documents::create(&pool, WS, Some("Venue notes"))
            .await
            .unwrap();
        document_links::link(&pool, WS, Owner::Issue, &id, &document.id)
            .await
            .unwrap();
        let block = create_work_block(
            &pool,
            WS,
            WorkBlockInput {
                issue_id: id.clone(),
                time_zone: ZONE.into(),
                start: "2026-11-17T14:00".into(),
                end: "2026-11-17T15:00".into(),
            },
        )
        .await
        .unwrap();

        let dashboard = || async {
            workspace_analytics(&pool, WS, "2026-11-01", "2026-11-30", None, ZONE, TODAY)
                .await
                .unwrap()
        };
        let before = dashboard().await;
        let issues_before = before.issues.data.unwrap();
        assert_eq!(
            (
                issues_before.open,
                issues_before.due,
                issues_before.due_completed
            ),
            (1, 1, 0)
        );
        let calendar = before.calendar.data.unwrap();
        assert_eq!((calendar.work_blocks, calendar.work_block_minutes), (1, 60));

        // Review: the same document is linked to the same issue.
        let linked = document_links::linked(&pool, WS, Owner::Issue, &id)
            .await
            .unwrap();
        assert_eq!(
            linked.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            [document.id.as_str()]
        );

        // Complete: the dashboard and progress follow the committed write; the
        // planned session stays a scheduled session on the closed issue.
        issues::set_status_on(&pool, WS, &id, "done", Some(TODAY))
            .await
            .unwrap();
        let after = dashboard().await;
        let issues_after = after.issues.data.unwrap();
        assert_eq!(
            (
                issues_after.open,
                issues_after.due,
                issues_after.due_completed
            ),
            (0, 1, 1)
        );
        assert_eq!(after.calendar.data.unwrap().work_blocks, 1);
        let totals = progress(&pool, WS, "2026-11-01", "2026-11-30", None, ZONE, TODAY)
            .await
            .unwrap()
            .totals;
        assert_eq!((totals.open, totals.done, totals.overdue), (0, 1, 0));

        // Reopen: back to where it was, with nothing duplicated.
        issues::set_status_on(&pool, WS, &id, "todo", Some(TODAY))
            .await
            .unwrap();
        let reopened = dashboard().await.issues.data.unwrap();
        assert_eq!((reopened.open, reopened.due_completed), (1, 0));
        pool.close().await;

        // Restart: everything is still the same records.
        let pool = open(&database).await;
        let blocks = list_work_blocks(&pool, WS, &id).await.unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].id, block.id);
        assert_eq!(
            document_links::linked(&pool, WS, Owner::Issue, &id)
                .await
                .unwrap()
                .len(),
            1
        );
        let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM issues")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        pool.close().await;
    });
}
