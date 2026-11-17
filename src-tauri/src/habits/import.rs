//! Import of an Ember desktop backup (`ember-backup`, version 1). The
//! contract is in docs/HABITS.md, "Import sources".
//!
//! The file is only read. A preview and an import run the same steps in one
//! transaction; the preview rolls back, the import commits. An import also
//! carries the preview's `token`, which covers the file and the workspace's
//! habits, so anything that changed in between is refused and reviewed again.
//! Every Ember habit gets a new UUID. Its Ember ID is kept as `source_id`, so
//! importing the same backup twice is detected and refused. Nothing is ever
//! merged by name.

use super::{scope, storage_failed, valid_date, valid_name, HabitError};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

/// Ember's own limit for a backup file.
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_HABITS: usize = 1_000;
const FORMAT: &str = "ember-backup";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmberHabit {
    id: String,
    name: String,
    sort_order: i64,
    start_date: String,
    archived_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Backup {
    #[allow(dead_code)]
    format: String,
    #[allow(dead_code)]
    version: u32,
    habits: Vec<EmberHabit>,
    completions: Vec<(String, String)>,
}

/// One habit the import adds, in the order it will have.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHabit {
    pub name: String,
    pub start_date: String,
    pub archived_on: Option<String>,
    pub completions: usize,
}

/// What an import does. A preview and an import return the same report.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// The whole file is refused, and why. Nothing changed.
    pub fatal: Option<String>,
    /// Habits the file collides with, when that is the reason.
    pub conflicts: Vec<String>,
    pub habits: Vec<ImportedHabit>,
    pub completions: usize,
    /// Pass back to import. It changes when the file or the habits change.
    pub token: String,
    pub applied: bool,
}

impl ImportReport {
    fn refused(message: impl Into<String>) -> Self {
        Self {
            fatal: Some(message.into()),
            conflicts: Vec::new(),
            habits: Vec::new(),
            completions: 0,
            token: String::new(),
            applied: false,
        }
    }
}

fn valid_ember_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Reads the file with Ember's rules. The message is for the person.
fn parse(content: &str) -> Result<Backup, String> {
    if content.len() > MAX_BYTES {
        return Err("The file is larger than 32 MiB.".into());
    }
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|_| "This is not a JSON file, so it is not an Ember backup.".to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "This is not an Ember backup.".to_string())?;
    if object.get("encoding").and_then(|v| v.as_str()) == Some("daily-bitmask-v1") {
        return Err(
            "This is an Ember website snapshot, not a backup. Import it into \
                    Ember desktop first, then export a backup there and choose that file."
                .into(),
        );
    }
    if object.get("format").and_then(|v| v.as_str()) != Some(FORMAT) {
        return Err("This is not an Ember desktop backup.".into());
    }
    match object.get("version").and_then(|v| v.as_u64()) {
        Some(1) => {}
        Some(newer) if newer > 1 => {
            return Err(format!(
                "This backup was made by a newer Ember (version {newer}). \
                 This app reads version 1 only."
            ))
        }
        _ => {
            return Err("This backup's version is not supported. Choose a version 1 backup.".into())
        }
    }
    let backup: Backup = serde_json::from_value(value)
        .map_err(|error| format!("The backup is not valid: {error}"))?;
    validate(&backup)?;
    Ok(backup)
}

fn validate(backup: &Backup) -> Result<(), String> {
    if backup.habits.len() > MAX_HABITS {
        return Err(format!("The backup has more than {MAX_HABITS} habits."));
    }
    let bad_date = |what: &str| format!("{what} is not a valid calendar date.");
    let mut by_id: HashMap<&str, &EmberHabit> = HashMap::new();
    let mut orders = HashSet::new();
    let mut active_names = HashSet::new();
    for habit in &backup.habits {
        if !valid_ember_id(&habit.id) {
            return Err("A habit has an invalid ID.".into());
        }
        let (name, key) = valid_name(&habit.name)
            .map_err(|_| "A habit name must have 1 to 60 characters.".to_string())?;
        valid_date(&habit.start_date).map_err(|_| bad_date(&format!("{name}'s start")))?;
        if let Some(end) = &habit.archived_at {
            valid_date(end).map_err(|_| bad_date(&format!("{name}'s archive day")))?;
            if *end < habit.start_date {
                return Err(format!("{name} was archived before it started."));
            }
        } else if !active_names.insert(key) {
            return Err(format!("Two active habits are named {name}."));
        }
        if habit.sort_order < 0
            || !orders.insert(habit.sort_order)
            || by_id.insert(&habit.id, habit).is_some()
        {
            return Err("The backup repeats a habit or its order.".into());
        }
    }
    let mut seen = HashSet::new();
    for (id, date) in &backup.completions {
        valid_date(date).map_err(|_| bad_date("A completion's day"))?;
        let habit = by_id
            .get(id.as_str())
            .ok_or("A completion belongs to a habit that is not in the file.")?;
        if *date < habit.start_date
            || habit.archived_at.as_ref().is_some_and(|end| date > end)
            || !seen.insert((id, date))
        {
            return Err(format!(
                "{} has a repeated completion or one outside its active days.",
                habit.name.trim()
            ));
        }
    }
    Ok(())
}

/// Previews (`confirm` is `None`) or imports (`confirm` is the preview's token)
/// into `workspace`. Database failures are errors; anything wrong with the file
/// or a collision is a refusal in the report. Nothing is written unless the
/// whole import succeeds.
pub async fn run(
    pool: &SqlitePool,
    workspace: &str,
    content: &str,
    confirm: Option<&str>,
) -> Result<ImportReport, HabitError> {
    let backup = match parse(content) {
        Ok(backup) => backup,
        Err(message) => return Ok(ImportReport::refused(message)),
    };
    let mut tx = pool
        .begin_with(if confirm.is_some() {
            "BEGIN IMMEDIATE"
        } else {
            "BEGIN"
        })
        .await
        .map_err(storage_failed)?;

    // (id, name_key, active, source_id, revision)
    let existing: Vec<(String, String, bool, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, name_key, archived_on IS NULL, source_id, revision
         FROM habits WHERE workspace_id = ? ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(&mut *tx)
    .await
    .map_err(storage_failed)?;
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    existing
        .iter()
        .for_each(|(id, _, active, _, revision)| (id, active, revision).hash(&mut hasher));
    let token = format!("{:016x}", hasher.finish());

    let mut incoming = backup.habits.iter().collect::<Vec<_>>();
    incoming.sort_by_key(|habit| habit.sort_order);
    let imported: HashSet<&str> = existing.iter().filter_map(|row| row.3.as_deref()).collect();
    let active_here: HashSet<&str> = existing
        .iter()
        .filter(|row| row.2)
        .map(|row| row.1.as_str())
        .collect();
    let repeated: Vec<String> = incoming
        .iter()
        .filter(|habit| imported.contains(habit.id.as_str()))
        .map(|habit| habit.name.trim().to_owned())
        .collect();
    let same_name: Vec<String> = incoming
        .iter()
        .filter(|habit| {
            habit.archived_at.is_none()
                && !imported.contains(habit.id.as_str())
                && active_here.contains(habit.name.trim().to_lowercase().as_str())
        })
        .map(|habit| habit.name.trim().to_owned())
        .collect();
    if !repeated.is_empty() || !same_name.is_empty() {
        let mut message = Vec::new();
        if !repeated.is_empty() {
            message.push(format!(
                "Already imported from this backup: {}.",
                repeated.join(", ")
            ));
        }
        if !same_name.is_empty() {
            message.push(format!(
                "Active habits here already have these names: {}. Rename or archive \
                 them, then import again. Habits are never merged by name.",
                same_name.join(", ")
            ));
        }
        let mut report = ImportReport::refused(message.join(" "));
        report.conflicts = repeated.into_iter().chain(same_name).collect();
        return Ok(report);
    }
    if confirm.is_some_and(|expected| expected != token) {
        return Ok(ImportReport::refused(
            "Your habits or the file changed since the preview. Review the import again.",
        ));
    }

    let mut position: i64 = sqlx::query_scalar(
        "SELECT coalesce(max(position), -1) + 1 FROM habits WHERE workspace_id = ?",
    )
    .bind(workspace)
    .fetch_one(&mut *tx)
    .await
    .map_err(storage_failed)?;
    let mut dates: HashMap<&str, Vec<&str>> = HashMap::new();
    for (id, date) in &backup.completions {
        dates.entry(id.as_str()).or_default().push(date.as_str());
    }
    let mut habits = Vec::new();
    for habit in incoming {
        let (name, key) = valid_name(&habit.name)?;
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO habits (id, workspace_id, name, name_key, position, start_date,
                                 archived_on, source, source_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'ember', ?)",
        )
        .bind(&id)
        .bind(workspace)
        .bind(&name)
        .bind(key)
        .bind(position)
        .bind(&habit.start_date)
        .bind(&habit.archived_at)
        .bind(&habit.id)
        .execute(&mut *tx)
        .await
        .map_err(storage_failed)?;
        position += 1;
        let days = dates.remove(habit.id.as_str()).unwrap_or_default();
        if !days.is_empty() {
            sqlx::query(
                "INSERT INTO habit_completions (habit_id, workspace_id, date)
                 SELECT ?, ?, value FROM json_each(?)",
            )
            .bind(&id)
            .bind(workspace)
            .bind(serde_json::to_string(&days).map_err(|_| HabitError::StorageFailed)?)
            .execute(&mut *tx)
            .await
            .map_err(storage_failed)?;
        }
        habits.push(ImportedHabit {
            name,
            start_date: habit.start_date.clone(),
            archived_on: habit.archived_at.clone(),
            completions: days.len(),
        });
    }
    let applied = confirm.is_some();
    if applied {
        tx.commit().await.map_err(storage_failed)?;
    } else {
        tx.rollback().await.map_err(storage_failed)?;
    }
    Ok(ImportReport {
        fatal: None,
        conflicts: Vec::new(),
        completions: habits.iter().map(|habit| habit.completions).sum(),
        habits,
        token,
        applied,
    })
}

// --- Commands --------------------------------------------------------------

/// What the native file dialog chose.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub name: String,
    pub content: String,
}

/// Asks for a `.json` file with the native dialog and reads it. `None` when
/// the user cancels. Files over 32 MiB or not valid UTF-8 are refused. The
/// file is only read.
pub(super) async fn pick<R: Runtime>(
    app: AppHandle<R>,
    label: &'static str,
) -> Result<Option<PickedFile>, HabitError> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter(label, &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|_| HabitError::FileFailed)?;
        let size = std::fs::metadata(&path)
            .map_err(|_| HabitError::FileFailed)?
            .len();
        if size > MAX_BYTES as u64 {
            return Err(HabitError::FileTooLarge);
        }
        let bytes = std::fs::read(&path).map_err(|_| HabitError::FileFailed)?;
        let content = String::from_utf8(bytes).map_err(|_| HabitError::FileFailed)?;
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(Some(PickedFile { name, content }))
    })
    .await
    .map_err(|_| HabitError::FileFailed)?
}

#[tauri::command]
pub async fn pick_habit_backup<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<PickedFile>, HabitError> {
    pick(app, "Ember backup").await
}

#[tauri::command]
pub async fn preview_habit_import(
    instances: State<'_, DbInstances>,
    content: String,
) -> Result<ImportReport, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    run(&pool, &workspace, &content, None).await
}

#[tauri::command]
pub async fn import_habits(
    instances: State<'_, DbInstances>,
    content: String,
    token: String,
) -> Result<ImportReport, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    run(&pool, &workspace, &content, Some(&token)).await
}
