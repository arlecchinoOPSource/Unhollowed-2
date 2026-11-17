//! The Phase 3 workflow end to end on disposable file databases: upgrade a
//! database from before scheduling, create, schedule, link, remind, search,
//! exchange through ICS, and restart. docs/PHASE_3.md records the results.

use super::search::{search_items, CalendarSearch};
use super::{
    create_event, create_work_block, ics, links, list_items, list_work_blocks, reminders,
    EventInput, ItemKind, ItemRange, WorkBlockInput,
};
use crate::test_support::{
    add_issue_before_upgrade, add_project, migrator, TempDatabase, DEFAULT_WORKSPACE,
};

const WS: &str = DEFAULT_WORKSPACE;

fn range() -> ItemRange {
    ItemRange {
        from: "2026-11-16".into(),
        to: "2026-11-23".into(),
        time_zone: "Europe/Paris".into(),
    }
}

fn query(text: &str) -> CalendarSearch {
    CalendarSearch {
        text: text.into(),
        time_zone: "Europe/Paris".into(),
        today: "2026-11-16".into(),
        kinds: None,
        calendar_ids: None,
        include_completed: false,
    }
}

#[test]
fn create_schedule_link_remind_search_exchange_and_restart() {
    tauri::async_runtime::block_on(async {
        let source = TempDatabase::new("journey-source");
        let target = TempDatabase::new("journey-target");

        // A database from before scheduling, with an issue due on the 20th.
        let pool = source.open().await;
        migrator(19).await.run(&pool).await.unwrap();
        let issue = add_issue_before_upgrade(&pool, WS, None).await;
        sqlx::query("UPDATE issues SET due_date = '2026-11-20' WHERE id = ?")
            .bind(&issue)
            .execute(&pool)
            .await
            .unwrap();
        migrator(i64::MAX).await.run(&pool).await.unwrap();

        // Create, with a repeat and a document and project to link.
        let project = add_project(&pool, WS, "Launch").await;
        let document = crate::documents::create(&pool, WS, Some("Kickoff notes"))
            .await
            .unwrap()
            .id;
        let meeting = create_event(
            &pool,
            WS,
            EventInput {
                title: "Kickoff review".into(),
                description: "Walk through the launch plan".into(),
                location: Some("Room 4".into()),
                time_zone: Some("Europe/Paris".into()),
                start: Some("2026-11-18T09:00".into()),
                end: Some("2026-11-18T10:00".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        // Schedule work on the existing issue without touching its deadline.
        create_work_block(
            &pool,
            WS,
            WorkBlockInput {
                issue_id: issue.clone(),
                time_zone: "Europe/Paris".into(),
                start: "2026-11-19T14:00".into(),
                end: "2026-11-19T16:00".into(),
            },
        )
        .await
        .unwrap();
        // Link and remind.
        links::link(&pool, WS, &meeting.id, links::Target::Document, &document)
            .await
            .unwrap();
        links::link(&pool, WS, &meeting.id, links::Target::Project, &project)
            .await
            .unwrap();
        reminders::set_reminder(&pool, WS, &meeting.id, Some(15))
            .await
            .unwrap();

        // Views show the three item kinds without any extra rows.
        let kinds = |items: Vec<super::CalendarItem>| {
            let mut kinds: Vec<_> = items.iter().map(|item| item.kind).collect();
            kinds.sort_by_key(|kind| format!("{kind:?}"));
            kinds
        };
        let items = list_items(&pool, WS, range()).await.unwrap().items;
        assert_eq!(
            kinds(items),
            [ItemKind::Deadline, ItemKind::Event, ItemKind::WorkBlock]
        );
        let found = search_items(&pool, WS, query("kickoff")).await.unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].title, "Kickoff review");

        // A reminder is due 15 minutes before 09:00 Paris (08:00 UTC), once.
        let due = reminders::claim_due(&pool, WS, "2026-11-18T07:46:00Z".parse().unwrap())
            .await
            .unwrap();
        assert_eq!(due.len(), 1);

        // Exchange through ICS into an empty database.
        let (file, written) = ics::export(&pool, WS).await.unwrap();
        assert_eq!(written, 1);
        let other = target.open().await;
        migrator(i64::MAX).await.run(&other).await.unwrap();
        let report = ics::import(&other, WS, &file, None, "Europe/Paris", true)
            .await
            .unwrap();
        assert_eq!(report.imported.len(), 1, "{report:?}");
        let again = ics::import(&other, WS, &file, None, "Europe/Paris", true)
            .await
            .unwrap();
        assert_eq!(again.duplicates.len(), 1);
        pool.close().await;
        other.close().await;

        // Restart both: everything is still there, and the reminder and the
        // issue's deadline are unchanged.
        let pool = source.open().await;
        migrator(i64::MAX).await.run(&pool).await.unwrap();
        let reopened = links::links(&pool, WS, &meeting.id).await.unwrap();
        assert_eq!(reopened.documents[0].title, "Kickoff notes");
        assert_eq!(reopened.projects[0].title, "Launch");
        assert_eq!(
            reminders::reminder(&pool, WS, &meeting.id).await.unwrap(),
            Some(15)
        );
        assert!(
            reminders::claim_due(&pool, WS, "2026-11-18T07:50:00Z".parse().unwrap())
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(list_work_blocks(&pool, WS, &issue).await.unwrap().len(), 1);
        let due_date: String = sqlx::query_scalar("SELECT due_date FROM issues WHERE id = ?")
            .bind(&issue)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(due_date, "2026-11-20");
        assert_eq!(
            search_items(&pool, WS, query("kickoff"))
                .await
                .unwrap()
                .items
                .len(),
            1
        );
        pool.close().await;

        let other = target.open().await;
        migrator(i64::MAX).await.run(&other).await.unwrap();
        let items = list_items(&other, WS, range()).await.unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Kickoff review");
        assert_eq!(items[0].start.as_deref(), Some("2026-11-18T09:00"));
        other.close().await;
    });
}
