//! Habit exports, the versioned backup, and restore. docs/HABITS.md,
//! "Backup and restore", is the contract.
//!
//! A backup (`unhollowed-2/habits`, version 1) holds every habit in order,
//! empty and archived ones included, with its completed days. CSV and JSON
//! history are exports for reading elsewhere, not backups. Restoring replaces
//! the active workspace's habits and nothing else. It is previewed first, and
//! before anything is replaced a private copy of the current habits is
//! written; if that fails, nothing changes. The copy is itself a backup, so
//! "undo" is a restore of it. Restored habits get new IDs, so a backup also
//! restores into a workspace that still holds the originals.

use super::import::{pick, PickedFile, MAX_BYTES};
use super::{list, scope, storage_failed, valid_date, valid_name, HabitError};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

pub const FORMAT: &str = "unhollowed-2/habits";
pub const VERSION: u32 = 1;
const MAX_HABITS: usize = 1_000;
const COPY_PREFIX: &str = "habits-pre-restore-";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupHabit {
    /// Only links completions to habits inside this file.
    id: String,
    name: String,
    start_date: String,
    archived_on: Option<String>,
    source: Option<String>,
    source_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Backup {
    format: String,
    version: u32,
    exported_at: String,
    /// In the saved order.
    habits: Vec<BackupHabit>,
    completions: Vec<(String, String)>,
}

async fn snapshot(
    connection: &mut sqlx::SqliteConnection,
    workspace: &str,
) -> Result<Backup, HabitError> {
    let habits: Vec<(
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT id, name, start_date, archived_on, source, source_id
             FROM habits WHERE workspace_id = ? ORDER BY position",
    )
    .bind(workspace)
    .fetch_all(&mut *connection)
    .await
    .map_err(storage_failed)?;
    let completions: Vec<(String, String)> = sqlx::query_as(
        "SELECT c.habit_id, c.date FROM habit_completions AS c
         JOIN habits AS h ON h.id = c.habit_id
         WHERE h.workspace_id = ? ORDER BY c.date, h.position",
    )
    .bind(workspace)
    .fetch_all(&mut *connection)
    .await
    .map_err(storage_failed)?;
    Ok(Backup {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: jiff::Timestamp::now().to_string(),
        habits: habits
            .into_iter()
            .map(
                |(id, name, start_date, archived_on, source, source_id)| BackupHabit {
                    id,
                    name,
                    start_date,
                    archived_on,
                    source,
                    source_id,
                },
            )
            .collect(),
        completions,
    })
}

/// What an export wrote.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedHabits {
    pub path: String,
    pub habits: usize,
    pub completions: usize,
}

fn encode(backup: &Backup) -> Result<String, HabitError> {
    let content = serde_json::to_string_pretty(backup).map_err(|_| HabitError::StorageFailed)?;
    if content.len() > MAX_BYTES {
        return Err(HabitError::FileTooLarge);
    }
    Ok(content)
}

/// The backup as JSON, with its habit and completion counts.
pub async fn backup_json(
    pool: &SqlitePool,
    workspace: &str,
) -> Result<(String, usize, usize), HabitError> {
    let mut connection = pool.acquire().await.map_err(storage_failed)?;
    let backup = snapshot(&mut connection, workspace).await?;
    Ok((
        encode(&backup)?,
        backup.habits.len(),
        backup.completions.len(),
    ))
}

/// A CSV cell. A value a spreadsheet would run as a formula is prefixed with
/// an apostrophe, and quotes are doubled.
fn csv_cell(value: &str) -> String {
    let guard = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        "'"
    } else {
        ""
    };
    format!("\"{guard}{}\"", value.replace('"', "\"\""))
}

/// One row per completed day: `date, habit_id, habit_name`. Habits without a
/// completed day do not appear, so this is not a backup.
pub async fn history(
    pool: &SqlitePool,
    workspace: &str,
    format: &str,
) -> Result<(String, usize), HabitError> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT c.date, h.id, h.name FROM habit_completions AS c
         JOIN habits AS h ON h.id = c.habit_id
         WHERE h.workspace_id = ? ORDER BY c.date, h.position",
    )
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;
    let content = match format {
        "csv" => {
            let mut csv = String::from("date,habit_id,habit_name\r\n");
            for (date, id, name) in &rows {
                csv.push_str(&format!(
                    "{},{},{}\r\n",
                    csv_cell(date),
                    csv_cell(id),
                    csv_cell(name)
                ));
            }
            csv
        }
        "json" => serde_json::to_string_pretty(
            &rows
                .iter()
                .map(|(date, id, name)| {
                    serde_json::json!({ "date": date, "habitId": id, "habitName": name })
                })
                .collect::<Vec<_>>(),
        )
        .map_err(|_| HabitError::StorageFailed)?,
        _ => return Err(HabitError::InvalidFormat),
    };
    if content.len() > MAX_BYTES {
        return Err(HabitError::FileTooLarge);
    }
    Ok((content, rows.len()))
}

// --- Restore ---------------------------------------------------------------

/// Reads a backup with every check before any write. The message is for the
/// person.
fn parse(content: &str) -> Result<Backup, String> {
    if content.len() > MAX_BYTES {
        return Err("The file is larger than 32 MiB.".into());
    }
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|_| "This is not a JSON file, so it is not a habit backup.".to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "This is not a habit backup.".to_string())?;
    if object.get("format").and_then(|v| v.as_str()) != Some(FORMAT) {
        return Err("This is not a habit backup from this app.".into());
    }
    match object.get("version").and_then(|v| v.as_u64()) {
        Some(1) => {}
        Some(newer) if newer > 1 => {
            return Err(format!(
                "This backup was made by a newer version of the app (format {newer}). \
                 This version reads format 1 only."
            ))
        }
        _ => return Err("This backup's version is not supported.".into()),
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
    let mut by_id: HashMap<&str, &BackupHabit> = HashMap::new();
    let mut active_names = HashSet::new();
    let mut sources = HashSet::new();
    for habit in &backup.habits {
        if habit.id.is_empty() || habit.id.chars().count() > 64 {
            return Err("A habit has an invalid ID.".into());
        }
        let (name, key) = valid_name(&habit.name)
            .map_err(|_| "A habit name must have 1 to 60 characters.".to_string())?;
        valid_date(&habit.start_date).map_err(|_| bad_date(&format!("{name}'s start")))?;
        match &habit.archived_on {
            Some(end) => {
                valid_date(end).map_err(|_| bad_date(&format!("{name}'s archive day")))?;
                if *end < habit.start_date {
                    return Err(format!("{name} was archived before it started."));
                }
            }
            None if !active_names.insert(key) => {
                return Err(format!("Two active habits are named {name}."));
            }
            None => {}
        }
        match (habit.source.as_deref(), habit.source_id.as_deref()) {
            (None, None) => {}
            (Some("ember"), Some(id)) if (1..=64).contains(&id.chars().count()) => {
                if !sources.insert(id) {
                    return Err(format!("{name} repeats another habit's source."));
                }
            }
            _ => return Err(format!("{name} has an invalid source.")),
        }
        if by_id.insert(&habit.id, habit).is_some() {
            return Err("The backup repeats a habit.".into());
        }
    }
    let mut seen = HashSet::new();
    for (id, date) in &backup.completions {
        valid_date(date).map_err(|_| bad_date("A completion's day"))?;
        let habit = by_id
            .get(id.as_str())
            .ok_or("A completion belongs to a habit that is not in the file.")?;
        if *date < habit.start_date
            || habit.archived_on.as_ref().is_some_and(|end| date > end)
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

/// What a restore does, or did.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// The restore is refused, and why. Nothing changed.
    pub fatal: Option<String>,
    pub habits: usize,
    pub archived: usize,
    pub completions: usize,
    /// What the restore replaces.
    pub current_habits: usize,
    pub current_completions: usize,
    /// Pass back to restore. It changes when the file or the habits change.
    pub token: String,
    pub applied: bool,
    /// The private copy of the replaced habits, by name. Pass it to undo.
    pub recovery: Option<String>,
}

impl RestoreReport {
    fn refused(message: impl Into<String>) -> Self {
        Self {
            fatal: Some(message.into()),
            habits: 0,
            archived: 0,
            completions: 0,
            current_habits: 0,
            current_completions: 0,
            token: String::new(),
            applied: false,
            recovery: None,
        }
    }
}

/// Writes `content` as a new file only its owner can read, and returns its
/// name. The data is on disk before this returns.
fn write_copy(folder: &Path, content: &str) -> Result<String, std::io::Error> {
    std::fs::create_dir_all(folder)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700))?;
    }
    let name = format!(
        "{COPY_PREFIX}{}.json",
        jiff::Timestamp::now().as_nanosecond()
    );
    let path = folder.join(&name);
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    if let Err(error) = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(name)
}

/// Previews (`confirm` is `None`) or restores (`confirm` is the preview's
/// token) `content` over the workspace's habits. Copies go to `folder`.
pub async fn restore(
    pool: &SqlitePool,
    workspace: &str,
    content: &str,
    confirm: Option<&str>,
    folder: &Path,
) -> Result<RestoreReport, HabitError> {
    let backup = match parse(content) {
        Ok(backup) => backup,
        Err(message) => return Ok(RestoreReport::refused(message)),
    };
    let mut tx = pool
        .begin_with(if confirm.is_some() {
            "BEGIN IMMEDIATE"
        } else {
            "BEGIN"
        })
        .await
        .map_err(storage_failed)?;
    let current = snapshot(&mut tx, workspace).await?;
    let revisions: Vec<(String, i64)> =
        sqlx::query_as("SELECT id, revision FROM habits WHERE workspace_id = ? ORDER BY id")
            .bind(workspace)
            .fetch_all(&mut *tx)
            .await
            .map_err(storage_failed)?;
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    revisions.hash(&mut hasher);
    let token = format!("{:016x}", hasher.finish());
    let mut report = RestoreReport {
        fatal: None,
        habits: backup.habits.len(),
        archived: backup
            .habits
            .iter()
            .filter(|habit| habit.archived_on.is_some())
            .count(),
        completions: backup.completions.len(),
        current_habits: current.habits.len(),
        current_completions: current.completions.len(),
        token,
        applied: false,
        recovery: None,
    };
    let Some(expected) = confirm else {
        return Ok(report);
    };
    if expected != report.token {
        return Ok(RestoreReport::refused(
            "Your habits or the file changed since the preview. Review the restore again.",
        ));
    }

    // The copy comes first: without it nothing is replaced.
    let copy = encode(&current)?;
    report.recovery = Some(write_copy(folder, &copy).map_err(|error| {
        eprintln!("Could not write the pre-restore copy: {error}");
        HabitError::CopyFailed
    })?);

    sqlx::query("DELETE FROM habit_completions WHERE workspace_id = ?")
        .bind(workspace)
        .execute(&mut *tx)
        .await
        .map_err(storage_failed)?;
    sqlx::query("DELETE FROM habits WHERE workspace_id = ?")
        .bind(workspace)
        .execute(&mut *tx)
        .await
        .map_err(storage_failed)?;
    let mut days: HashMap<&str, Vec<&str>> = HashMap::new();
    for (id, date) in &backup.completions {
        days.entry(id.as_str()).or_default().push(date.as_str());
    }
    for (position, habit) in backup.habits.iter().enumerate() {
        let (name, key) = valid_name(&habit.name)?;
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO habits (id, workspace_id, name, name_key, position, start_date,
                                 archived_on, source, source_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(workspace)
        .bind(name)
        .bind(key)
        .bind(position as i64)
        .bind(&habit.start_date)
        .bind(&habit.archived_on)
        .bind(&habit.source)
        .bind(&habit.source_id)
        .execute(&mut *tx)
        .await
        .map_err(storage_failed)?;
        if let Some(dates) = days.get(habit.id.as_str()) {
            sqlx::query(
                "INSERT INTO habit_completions (habit_id, workspace_id, date)
                 SELECT ?, ?, value FROM json_each(?)",
            )
            .bind(&id)
            .bind(workspace)
            .bind(serde_json::to_string(dates).map_err(|_| HabitError::StorageFailed)?)
            .execute(&mut *tx)
            .await
            .map_err(storage_failed)?;
        }
    }
    tx.commit().await.map_err(storage_failed)?;
    report.applied = true;
    Ok(report)
}

/// Restores the copy a restore made. The undo makes its own copy first, so it
/// can be undone too. `name` is a file name inside `folder`, never a path.
pub async fn undo(
    pool: &SqlitePool,
    workspace: &str,
    name: &str,
    folder: &Path,
) -> Result<RestoreReport, HabitError> {
    let digits = name
        .strip_prefix(COPY_PREFIX)
        .and_then(|rest| rest.strip_suffix(".json"));
    if !digits.is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())) {
        return Err(HabitError::NotFound);
    }
    let path = folder.join(name);
    let size = std::fs::metadata(&path)
        .map_err(|_| HabitError::FileFailed)?
        .len();
    if size > MAX_BYTES as u64 {
        return Err(HabitError::FileTooLarge);
    }
    let content = std::fs::read_to_string(&path).map_err(|_| HabitError::FileFailed)?;
    let seen = restore(pool, workspace, &content, None, folder).await?;
    if seen.fatal.is_some() {
        return Ok(seen);
    }
    restore(pool, workspace, &content, Some(&seen.token), folder).await
}

// --- Commands --------------------------------------------------------------

fn copies_folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, HabitError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("habit-copies"))
        .map_err(|_| HabitError::CopyFailed)
}

/// Asks where to save with the native dialog, then writes `content`.
async fn save<R: Runtime>(
    app: AppHandle<R>,
    file_name: String,
    filter: (&'static str, &'static str),
    content: String,
) -> Result<Option<String>, HabitError> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name(file_name)
            .add_filter(filter.0, &[filter.1])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|_| HabitError::FileFailed)?;
        std::fs::write(&path, content).map_err(|error| {
            eprintln!("Could not write {}: {error}", path.display());
            HabitError::FileFailed
        })?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(|_| HabitError::FileFailed)?
}

fn today_stamp() -> String {
    jiff::Zoned::now().date().to_string()
}

#[tauri::command]
pub async fn export_habit_backup<R: Runtime>(
    app: AppHandle<R>,
    instances: State<'_, DbInstances>,
) -> Result<Option<SavedHabits>, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    let (content, habits, completions) = backup_json(&pool, &workspace).await?;
    let name = format!("unhollowed-habits-backup-{}.json", today_stamp());
    Ok(save(app, name, ("Habit backup", "json"), content)
        .await?
        .map(|path| SavedHabits {
            path,
            habits,
            completions,
        }))
}

#[tauri::command]
pub async fn export_habit_history<R: Runtime>(
    app: AppHandle<R>,
    instances: State<'_, DbInstances>,
    format: String,
) -> Result<Option<SavedHabits>, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    let (content, completions) = history(&pool, &workspace, &format).await?;
    let (label, extension) = if format == "csv" {
        ("CSV", "csv")
    } else {
        ("JSON", "json")
    };
    let name = format!("unhollowed-habit-history-{}.{extension}", today_stamp());
    let habits = list(&pool, &workspace).await?.len();
    Ok(save(app, name, (label, extension), content)
        .await?
        .map(|path| SavedHabits {
            path,
            habits,
            completions,
        }))
}

#[tauri::command]
pub async fn pick_habit_restore<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<PickedFile>, HabitError> {
    pick(app, "Habit backup").await
}

#[tauri::command]
pub async fn preview_habit_restore<R: Runtime>(
    app: AppHandle<R>,
    instances: State<'_, DbInstances>,
    content: String,
) -> Result<RestoreReport, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    restore(&pool, &workspace, &content, None, &copies_folder(&app)?).await
}

#[tauri::command]
pub async fn restore_habits<R: Runtime>(
    app: AppHandle<R>,
    instances: State<'_, DbInstances>,
    content: String,
    token: String,
) -> Result<RestoreReport, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    restore(
        &pool,
        &workspace,
        &content,
        Some(&token),
        &copies_folder(&app)?,
    )
    .await
}

#[tauri::command]
pub async fn undo_habit_restore<R: Runtime>(
    app: AppHandle<R>,
    instances: State<'_, DbInstances>,
    name: String,
) -> Result<RestoreReport, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    undo(&pool, &workspace, &name, &copies_folder(&app)?).await
}
