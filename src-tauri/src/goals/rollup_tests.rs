//! Rollups of objectives, missions, and milestones, as documented in
//! docs/DATA_MODEL.md under "Progress rollups".

use super::*;
use crate::issues::{reopen, set_project, set_status};
use crate::relationships::{add, remove, RelationKind};
use crate::test_support::{add_issue, add_project, migrated_pool, DEFAULT_WORKSPACE};

fn goal(title: &str) -> GoalText {
    GoalText {
        title: title.into(),
        description: String::new(),
    }
}

async fn objective(
    db: &SqlitePool,
    project: &str,
    title: &str,
    mission: Option<&str>,
    issues: &[&str],
) {
    save_objective(
        db,
        DEFAULT_WORKSPACE,
        project,
        None,
        ObjectiveInput {
            text: goal(title),
            mission_id: mission.map(Into::into),
            issue_ids: issues.iter().map(|id| id.to_string()).collect(),
        },
    )
    .await
    .unwrap();
}

/// (total, completed, blocked, canceled) for each objective and mission.
async fn rollups(
    db: &SqlitePool,
    project: &str,
) -> (
    Vec<(String, (i64, i64, i64, i64))>,
    Vec<(String, (i64, i64, i64, i64))>,
) {
    let goals = load(db, DEFAULT_WORKSPACE, project).await.unwrap();
    let shape = |r: &Rollup| (r.total, r.completed, r.blocked, r.canceled);
    (
        goals
            .objectives
            .iter()
            .map(|o| (o.title.clone(), shape(&o.rollup)))
            .collect(),
        goals
            .missions
            .iter()
            .map(|m| (m.title.clone(), shape(&m.rollup)))
            .collect(),
    )
}

#[test]
fn missions_roll_up_their_objectives_counting_each_issue_once() {
    tauri::async_runtime::block_on(async {
        let db = migrated_pool().await;
        let project = add_project(&db, DEFAULT_WORKSPACE, "Launch").await;
        save_mission(&db, DEFAULT_WORKSPACE, &project, None, goal("Ship"))
            .await
            .unwrap();
        save_mission(&db, DEFAULT_WORKSPACE, &project, None, goal("Empty"))
            .await
            .unwrap();
        let goals = load(&db, DEFAULT_WORKSPACE, &project).await.unwrap();
        let ship = goals
            .missions
            .iter()
            .find(|m| m.title == "Ship")
            .unwrap()
            .id
            .clone();

        let issues: Vec<String> = {
            let mut ids = Vec::new();
            for _ in 0..4 {
                ids.push(add_issue(&db, DEFAULT_WORKSPACE, Some(&project)).await);
            }
            ids
        };
        set_status(&db, DEFAULT_WORKSPACE, &issues[0], "done")
            .await
            .unwrap();
        set_status(&db, DEFAULT_WORKSPACE, &issues[1], "blocked")
            .await
            .unwrap();
        set_status(&db, DEFAULT_WORKSPACE, &issues[3], "canceled")
            .await
            .unwrap();
        // Issue 0 is shared by both objectives.
        objective(&db, &project, "A", Some(&ship), &[&issues[0], &issues[1]]).await;
        objective(
            &db,
            &project,
            "B",
            Some(&ship),
            &[&issues[0], &issues[2], &issues[3]],
        )
        .await;
        objective(&db, &project, "Solo", None, &[]).await;

        let (objectives, missions) = rollups(&db, &project).await;
        assert_eq!(
            objectives,
            [
                ("A".into(), (2, 1, 1, 0)),
                ("B".into(), (2, 1, 0, 1)),
                ("Solo".into(), (0, 0, 0, 0)),
            ]
        );
        // The mission counts issues 0 to 3 once each: 3 counted, 1 canceled.
        assert_eq!(
            missions,
            [
                ("Empty".into(), (0, 0, 0, 0)),
                ("Ship".into(), (3, 1, 1, 1)),
            ]
        );
    });
}

#[test]
fn sub_issues_count_once_and_only_while_in_the_project() {
    tauri::async_runtime::block_on(async {
        let db = migrated_pool().await;
        let project = add_project(&db, DEFAULT_WORKSPACE, "Launch").await;
        let elsewhere = add_project(&db, DEFAULT_WORKSPACE, "Elsewhere").await;
        let epic = add_issue(&db, DEFAULT_WORKSPACE, Some(&project)).await;
        let child = add_issue(&db, DEFAULT_WORKSPACE, Some(&project)).await;
        let grandchild = add_issue(&db, DEFAULT_WORKSPACE, Some(&project)).await;
        add(&db, DEFAULT_WORKSPACE, &child, &epic, RelationKind::Parent)
            .await
            .unwrap();
        add(
            &db,
            DEFAULT_WORKSPACE,
            &grandchild,
            &child,
            RelationKind::Parent,
        )
        .await
        .unwrap();
        // The child is also linked directly: still counted once.
        objective(&db, &project, "Deliver", None, &[&epic, &child]).await;
        set_status(&db, DEFAULT_WORKSPACE, &grandchild, "done")
            .await
            .unwrap();
        assert_eq!(
            rollups(&db, &project).await.0,
            [("Deliver".into(), (3, 1, 0, 0))]
        );

        // Updates follow completion, reopening, cancellation, and blocking.
        set_status(&db, DEFAULT_WORKSPACE, &epic, "done")
            .await
            .unwrap();
        set_status(&db, DEFAULT_WORKSPACE, &child, "canceled")
            .await
            .unwrap();
        assert_eq!(
            rollups(&db, &project).await.0,
            [("Deliver".into(), (2, 2, 0, 1))]
        );
        reopen(&db, DEFAULT_WORKSPACE, &epic).await.unwrap();
        reopen(&db, DEFAULT_WORKSPACE, &child).await.unwrap();
        set_status(&db, DEFAULT_WORKSPACE, &child, "blocked")
            .await
            .unwrap();
        assert_eq!(
            rollups(&db, &project).await.0,
            [("Deliver".into(), (3, 1, 1, 0))]
        );

        // Removing the parent link drops the grandchild.
        remove(
            &db,
            DEFAULT_WORKSPACE,
            &grandchild,
            &child,
            RelationKind::Parent,
        )
        .await
        .unwrap();
        assert_eq!(
            rollups(&db, &project).await.0,
            [("Deliver".into(), (2, 0, 1, 0))]
        );

        // A sub-issue moved to another project stops counting.
        let late = add_issue(&db, DEFAULT_WORKSPACE, Some(&project)).await;
        add(&db, DEFAULT_WORKSPACE, &late, &epic, RelationKind::Parent)
            .await
            .unwrap();
        assert_eq!(rollups(&db, &project).await.0[0].1 .0, 3);
        set_project(&db, DEFAULT_WORKSPACE, &late, Some(&elsewhere))
            .await
            .unwrap();
        assert_eq!(rollups(&db, &project).await.0[0].1 .0, 2);

        // Moving a linked issue out also clears its direct link.
        set_project(&db, DEFAULT_WORKSPACE, &child, Some(&elsewhere))
            .await
            .unwrap();
        assert_eq!(
            rollups(&db, &project).await.0,
            [("Deliver".into(), (1, 0, 0, 0))]
        );
    });
}

#[test]
fn milestones_report_blocked_alongside_their_counts() {
    tauri::async_runtime::block_on(async {
        let db = migrated_pool().await;
        let milestone = crate::milestones::create(
            &db,
            DEFAULT_WORKSPACE,
            crate::milestones::MilestoneInput {
                title: "Beta".into(),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        for status in ["blocked", "blocked", "done", "todo"] {
            let id = add_issue(&db, DEFAULT_WORKSPACE, None).await;
            crate::issues::set_milestone(&db, DEFAULT_WORKSPACE, &id, Some(&milestone.id))
                .await
                .unwrap();
            set_status(&db, DEFAULT_WORKSPACE, &id, status)
                .await
                .unwrap();
        }
        let read = crate::milestones::get(&db, DEFAULT_WORKSPACE, &milestone.id)
            .await
            .unwrap();
        assert_eq!(
            (read.open_count, read.completed_count, read.blocked_count),
            (3, 1, 2)
        );
    });
}

#[test]
fn a_sub_issue_path_cannot_leave_and_reenter_the_project() {
    tauri::async_runtime::block_on(async {
        let db = migrated_pool().await;
        let project = add_project(&db, DEFAULT_WORKSPACE, "Local").await;
        let outside = add_project(&db, DEFAULT_WORKSPACE, "Outside").await;
        let root = add_issue(&db, DEFAULT_WORKSPACE, Some(&project)).await;
        let child = add_issue(&db, DEFAULT_WORKSPACE, Some(&outside)).await;
        let grandchild = add_issue(&db, DEFAULT_WORKSPACE, Some(&project)).await;
        for (from, to) in [(&child, &root), (&grandchild, &child)] {
            add(&db, DEFAULT_WORKSPACE, from, to, RelationKind::Parent)
                .await
                .unwrap();
        }
        save_mission(&db, DEFAULT_WORKSPACE, &project, None, goal("Ship"))
            .await
            .unwrap();
        let mission = load(&db, DEFAULT_WORKSPACE, &project)
            .await
            .unwrap()
            .missions
            .remove(0);
        objective(
            &db,
            &project,
            "Local objective",
            Some(&mission.id),
            &[&root],
        )
        .await;
        set_status(&db, DEFAULT_WORKSPACE, &grandchild, "done")
            .await
            .unwrap();
        let (objectives, missions) = rollups(&db, &project).await;
        assert_eq!(objectives[0].1, (1, 0, 0, 0));
        assert_eq!(missions[0].1, (1, 0, 0, 0));
    });
}
