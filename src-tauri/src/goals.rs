use crate::database::{active_workspace, pool, DatabaseError};
use crate::issues::{self, IssueError};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum GoalError {
    WorkspaceUnavailable,
    NotFound,
    InvalidTitle,
    InvalidDescription,
    InvalidLink,
    StorageFailed,
}

impl From<DatabaseError> for GoalError {
    fn from(_: DatabaseError) -> Self {
        Self::WorkspaceUnavailable
    }
}

impl From<sqlx::Error> for GoalError {
    fn from(error: sqlx::Error) -> Self {
        eprintln!("Project goals storage failed: {error}");
        Self::StorageFailed
    }
}

/// Progress over a deduplicated set of issues. `total` excludes canceled
/// issues, which are neither done nor outstanding; blocked issues count in
/// `total` but not in `completed`. A group with `total` 0 has no progress.
#[derive(Debug, Default, FromRow, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rollup {
    pub total: i64,
    pub completed: i64,
    pub blocked: i64,
    pub canceled: i64,
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    id: String,
    title: String,
    description: String,
    /// Every issue of the mission's objectives, each counted once.
    #[sqlx(flatten)]
    #[serde(flatten)]
    rollup: Rollup,
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Objective {
    id: String,
    title: String,
    description: String,
    mission_id: Option<String>,
    #[sqlx(flatten)]
    #[serde(flatten)]
    rollup: Rollup,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoals {
    missions: Vec<Mission>,
    objectives: Vec<Objective>,
    links: Vec<(String, String)>,
}

#[derive(Deserialize)]
pub struct GoalText {
    title: String,
    description: String,
}

impl GoalText {
    fn validate(&self) -> Result<(), GoalError> {
        if self.title.trim().is_empty()
            || self.title.trim().chars().count() > 200
            || self.title.contains('\0')
        {
            return Err(GoalError::InvalidTitle);
        }
        if self.description.chars().count() > 5000 || self.description.contains('\0') {
            return Err(GoalError::InvalidDescription);
        }
        Ok(())
    }
}

/// Each objective's issues: its linked issues and their sub-issues at any
/// depth, as distinct pairs. `UNION` removes repeats, which also ends the
/// recursion. Each hop must stay inside project (?1) and workspace (?2).
const MEMBERS: &str = "WITH RECURSIVE members (objective_id, issue_id) AS (
         SELECT l.objective_id, l.issue_id FROM objective_issues AS l
         JOIN objectives AS o ON o.id = l.objective_id WHERE o.project_id = ?1
         UNION
         SELECT m.objective_id, r.source_id FROM members AS m
         JOIN issue_relationships AS r ON r.workspace_id = ?2 AND r.kind = 'parent' AND r.target_id = m.issue_id
         JOIN issues AS child ON child.id = r.source_id AND child.project_id = ?1)";

/// Rollup counts over the joined issues `i`.
const ROLLUP: &str = "COUNT(CASE WHEN i.status <> 'canceled' THEN 1 END) AS total,
         COUNT(CASE WHEN i.status = 'done' THEN 1 END) AS completed,
         COUNT(CASE WHEN i.status = 'blocked' THEN 1 END) AS blocked,
         COUNT(CASE WHEN i.status = 'canceled' THEN 1 END) AS canceled";

async fn load(db: &SqlitePool, workspace: &str, project: &str) -> Result<ProjectGoals, GoalError> {
    let mut tx = db.begin().await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?)",
    )
    .bind(project)
    .bind(workspace)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(GoalError::NotFound);
    }
    let missions = sqlx::query_as(&format!(
        "{MEMBERS},
         mission_members AS (
             SELECT DISTINCT o.mission_id, m.issue_id FROM members AS m
             JOIN objectives AS o ON o.id = m.objective_id
             WHERE o.mission_id IS NOT NULL)
         SELECT ms.id, ms.title, ms.description, {ROLLUP}
         FROM missions AS ms
         LEFT JOIN mission_members AS mm ON mm.mission_id = ms.id
         LEFT JOIN issues AS i ON i.id = mm.issue_id AND i.project_id = ?1
         WHERE ms.project_id = ?1 GROUP BY ms.id ORDER BY ms.title COLLATE NOCASE, ms.id"
    ))
    .bind(project)
    .bind(workspace)
    .fetch_all(&mut *tx)
    .await?;
    let objectives = sqlx::query_as(&format!(
        "{MEMBERS}
         SELECT o.id, o.title, o.description, o.mission_id, {ROLLUP}
         FROM objectives AS o
         LEFT JOIN members AS m ON m.objective_id = o.id
         LEFT JOIN issues AS i ON i.id = m.issue_id AND i.project_id = ?1
         WHERE o.project_id = ?1 GROUP BY o.id ORDER BY o.title COLLATE NOCASE, o.id"
    ))
    .bind(project)
    .bind(workspace)
    .fetch_all(&mut *tx)
    .await?;
    let links = sqlx::query_as("SELECT l.objective_id, l.issue_id FROM objective_issues l JOIN objectives o ON o.id = l.objective_id WHERE o.project_id = ?")
        .bind(project).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(ProjectGoals {
        missions,
        objectives,
        links,
    })
}

async fn save_mission(
    db: &SqlitePool,
    workspace: &str,
    project: &str,
    id: Option<String>,
    text: GoalText,
) -> Result<(), GoalError> {
    text.validate()?;
    let result = if let Some(id) = id {
        sqlx::query("UPDATE missions SET title = ?, description = ? WHERE id = ? AND project_id = ?
             AND EXISTS (SELECT 1 FROM projects WHERE id = missions.project_id AND workspace_id = ?)")
            .bind(text.title.trim()).bind(text.description.trim()).bind(id).bind(project).bind(workspace)
            .execute(db).await?
    } else {
        sqlx::query(
            "INSERT INTO missions (id, project_id, title, description)
             SELECT ?, id, ?, ? FROM projects WHERE id = ? AND workspace_id = ?",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(text.title.trim())
        .bind(text.description.trim())
        .bind(project)
        .bind(workspace)
        .execute(db)
        .await?
    };
    if result.rows_affected() == 0 {
        return Err(GoalError::NotFound);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveInput {
    #[serde(flatten)]
    text: GoalText,
    mission_id: Option<String>,
    issue_ids: Vec<String>,
}

async fn save_objective(
    db: &SqlitePool,
    workspace: &str,
    project: &str,
    id: Option<String>,
    input: ObjectiveInput,
) -> Result<(), GoalError> {
    input.text.validate()?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    issues::ensure_project(&mut *tx, workspace, project)
        .await
        .map_err(|error| match error {
            IssueError::InvalidProject => GoalError::NotFound,
            _ => GoalError::StorageFailed,
        })?;
    if let Some(mission) = &input.mission_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM missions WHERE id = ? AND project_id = ?)",
        )
        .bind(mission)
        .bind(project)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(GoalError::InvalidLink);
        }
    }
    let title = input.text.title.trim();
    let description = input.text.description.trim();
    let id = if let Some(id) = id {
        let result = sqlx::query("UPDATE objectives SET title = ?, description = ?, mission_id = ? WHERE id = ? AND project_id = ?")
            .bind(title).bind(description).bind(input.mission_id).bind(&id).bind(project).execute(&mut *tx).await?;
        if result.rows_affected() == 0 {
            return Err(GoalError::NotFound);
        }
        id
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO objectives (id, project_id, title, description, mission_id) VALUES (?, ?, ?, ?, ?)")
            .bind(&id).bind(project).bind(title).bind(description).bind(input.mission_id).execute(&mut *tx).await?;
        id
    };
    sqlx::query("DELETE FROM objective_issues WHERE objective_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    for issue_id in input.issue_ids {
        let result = sqlx::query(
            "INSERT INTO objective_issues (objective_id, issue_id)
            SELECT ?, id FROM issues WHERE id = ? AND project_id = ? AND workspace_id = ?",
        )
        .bind(&id)
        .bind(issue_id)
        .bind(project)
        .bind(workspace)
        .execute(&mut *tx)
        .await;
        match result {
            Ok(result) if result.rows_affected() == 1 => (),
            Ok(_) => return Err(GoalError::InvalidLink),
            Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
                return Err(GoalError::InvalidLink)
            }
            Err(error) => return Err(error.into()),
        }
    }
    tx.commit().await?;
    Ok(())
}

async fn scope(instances: &DbInstances) -> Result<(SqlitePool, String), GoalError> {
    let db = pool(instances).await?;
    let workspace = active_workspace(&db).await?;
    Ok((db, workspace.id))
}

#[tauri::command]
pub async fn list_project_goals(
    instances: State<'_, DbInstances>,
    project_id: String,
) -> Result<ProjectGoals, GoalError> {
    let (db, workspace) = scope(&instances).await?;
    load(&db, &workspace, &project_id).await
}

#[tauri::command]
pub async fn save_project_mission(
    instances: State<'_, DbInstances>,
    project_id: String,
    id: Option<String>,
    input: GoalText,
) -> Result<(), GoalError> {
    let (db, workspace) = scope(&instances).await?;
    save_mission(&db, &workspace, &project_id, id, input).await
}

#[tauri::command]
pub async fn save_project_objective(
    instances: State<'_, DbInstances>,
    project_id: String,
    id: Option<String>,
    input: ObjectiveInput,
) -> Result<(), GoalError> {
    let (db, workspace) = scope(&instances).await?;
    save_objective(&db, &workspace, &project_id, id, input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        add_issue_before_upgrade, add_project, add_workspace, memory_pool, migrator,
        DEFAULT_WORKSPACE, OTHER_WORKSPACE,
    };

    fn text(title: &str) -> GoalText {
        GoalText {
            title: title.into(),
            description: "Sample outcome".into(),
        }
    }

    #[test]
    fn project_goals_support_optional_links_progress_and_workspace_boundaries() {
        tauri::async_runtime::block_on(async {
            let db = memory_pool().await;
            migrator(8).await.run(&db).await.unwrap();
            add_workspace(&db, OTHER_WORKSPACE, "Other").await;
            let project = add_project(&db, DEFAULT_WORKSPACE, "Launch").await;
            let other = add_project(&db, OTHER_WORKSPACE, "Other launch").await;
            let issue = add_issue_before_upgrade(&db, DEFAULT_WORKSPACE, Some(&project)).await;
            let other_issue = add_issue_before_upgrade(&db, OTHER_WORKSPACE, Some(&other)).await;
            // Upgrade through every later migration, as a user's database would.
            migrator(i64::MAX).await.run(&db).await.unwrap();

            let empty = load(&db, DEFAULT_WORKSPACE, &project).await.unwrap();
            assert!(empty.missions.is_empty() && empty.objectives.is_empty());
            assert!(matches!(
                load(&db, OTHER_WORKSPACE, &project).await,
                Err(GoalError::NotFound)
            ));
            save_mission(&db, DEFAULT_WORKSPACE, &project, None, text("Publish"))
                .await
                .unwrap();
            save_mission(&db, OTHER_WORKSPACE, &other, None, text("Other mission"))
                .await
                .unwrap();
            let mission = load(&db, DEFAULT_WORKSPACE, &project)
                .await
                .unwrap()
                .missions
                .remove(0);
            let other_mission = load(&db, OTHER_WORKSPACE, &other)
                .await
                .unwrap()
                .missions
                .remove(0);
            save_mission(
                &db,
                DEFAULT_WORKSPACE,
                &project,
                Some(mission.id.clone()),
                text("Release"),
            )
            .await
            .unwrap();

            save_objective(
                &db,
                DEFAULT_WORKSPACE,
                &project,
                None,
                ObjectiveInput {
                    text: text("Send three proposals"),
                    mission_id: None,
                    issue_ids: vec![],
                },
            )
            .await
            .unwrap();
            let objective = load(&db, DEFAULT_WORKSPACE, &project)
                .await
                .unwrap()
                .objectives
                .remove(0);
            assert_eq!(
                (
                    objective.rollup.total,
                    objective.rollup.completed,
                    objective.mission_id
                ),
                (0, 0, None)
            );

            let link = |mission_id, issue_ids| ObjectiveInput {
                text: text("Send proposal"),
                mission_id: Some(mission_id),
                issue_ids,
            };
            assert!(matches!(
                save_objective(
                    &db,
                    DEFAULT_WORKSPACE,
                    &project,
                    Some(objective.id.clone()),
                    link(other_mission.id, vec![])
                )
                .await,
                Err(GoalError::InvalidLink)
            ));
            assert!(matches!(
                save_objective(
                    &db,
                    DEFAULT_WORKSPACE,
                    &project,
                    Some(objective.id.clone()),
                    link(mission.id.clone(), vec![other_issue])
                )
                .await,
                Err(GoalError::InvalidLink)
            ));
            assert_eq!(
                load(&db, DEFAULT_WORKSPACE, &project)
                    .await
                    .unwrap()
                    .objectives[0]
                    .title,
                "Send three proposals"
            );
            save_objective(
                &db,
                DEFAULT_WORKSPACE,
                &project,
                Some(objective.id),
                link(mission.id.clone(), vec![issue.clone()]),
            )
            .await
            .unwrap();

            for (status, expected) in [("blocked", (1, 0)), ("done", (1, 1)), ("canceled", (0, 0))]
            {
                issues::set_status(&db, DEFAULT_WORKSPACE, &issue, status)
                    .await
                    .unwrap();
                let goals = load(&db, DEFAULT_WORKSPACE, &project).await.unwrap();
                assert_eq!(goals.missions[0].title, "Release");
                assert_eq!(
                    goals.objectives[0].mission_id.as_deref(),
                    Some(mission.id.as_str())
                );
                assert_eq!(
                    (
                        goals.objectives[0].rollup.total,
                        goals.objectives[0].rollup.completed
                    ),
                    expected
                );
            }
            issues::set_project(&db, DEFAULT_WORKSPACE, &issue, None)
                .await
                .unwrap();
            assert!(load(&db, DEFAULT_WORKSPACE, &project)
                .await
                .unwrap()
                .links
                .is_empty());
        });
    }
}

#[cfg(test)]
mod rollup_tests;
