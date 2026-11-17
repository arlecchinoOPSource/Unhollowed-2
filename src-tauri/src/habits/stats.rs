//! Habit statistics, computed from persisted history and never stored.
//! docs/HABITS.md, "Statistics", defines every number here, so dashboards and
//! summaries share one set of formulas.
//!
//! Counts are in habit-days. A habit is eligible from its start through its
//! archive day, inclusive, and never on a future day. A completed day is a
//! completion on an eligible day. Percentages are `None`, not zero, when
//! nothing was eligible: "no data" and "0% done" are different answers.
//! Streaks count consecutive calendar days with a completion; today stays open
//! until local midnight, so a streak that ended yesterday is still current.

use super::{list, scope, storage_failed, valid_date, Habit, HabitError};
use jiff::civil::Date;
use jiff::ToSpan;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::{BTreeSet, HashMap, HashSet};
use tauri::State;
use tauri_plugin_sql::DbInstances;

/// The longest period a request may cover, about 100 years.
const MAX_DAYS: i64 = 36_600;

/// A habit's dates and completed days, as the statistics see them.
pub struct HabitDays {
    pub id: String,
    pub name: String,
    pub start: Date,
    pub archived_on: Option<Date>,
    pub completed: BTreeSet<Date>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Streaks {
    /// Consecutive days ending today or yesterday; 0 when the run has ended.
    pub current: i64,
    pub longest: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub eligible: i64,
    pub completed: i64,
    /// 0 to 100. `None` when no day was eligible.
    pub percent: Option<f64>,
}

impl Counts {
    fn new(eligible: i64, completed: i64) -> Self {
        Self {
            eligible,
            completed,
            percent: (eligible > 0).then(|| completed as f64 * 100.0 / eligible as f64),
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitSummary {
    pub habit_id: String,
    pub name: String,
    pub archived: bool,
    #[serde(flatten)]
    pub counts: Counts,
    /// This habit's own streaks over all its history, not the period.
    pub streaks: Streaks,
}

/// One week (Monday to Sunday) or calendar month inside the period, clipped to
/// it. Its counts add up across the selected habits.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub start: String,
    pub end: String,
    #[serde(flatten)]
    pub counts: Counts,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitStatistics {
    pub today: String,
    pub from: String,
    pub to: String,
    /// The last day counted: the period's end, or today if that is earlier.
    pub through: String,
    /// All selected habits together over the period.
    pub summary: Counts,
    /// The selected habits, in saved order.
    pub habits: Vec<HabitSummary>,
    /// One bucket per day, for periods up to a year; empty for longer ones.
    pub days: Vec<Bucket>,
    pub weeks: Vec<Bucket>,
    pub months: Vec<Bucket>,
    /// Ember's practice streak: days with at least one completion in any habit
    /// of the workspace, archived included. Not limited to the period or to
    /// the selected habits.
    pub practice: Streaks,
}

fn day_count(from: Date, to: Date) -> i64 {
    from.until(to).map_or(0, |span| span.get_days() as i64) + 1
}

/// The days of `habit` inside `from..=to` that can count: on or after its
/// start, on or before its archive day, and not after today.
fn eligible_span(habit: &HabitDays, from: Date, to: Date, today: Date) -> Option<(Date, Date)> {
    let low = from.max(habit.start);
    let mut high = to.min(today);
    if let Some(end) = habit.archived_on {
        high = high.min(end);
    }
    (low <= high).then_some((low, high))
}

fn counts(habit: &HabitDays, from: Date, to: Date, today: Date) -> (i64, i64) {
    match eligible_span(habit, from, to, today) {
        Some((low, high)) => (
            day_count(low, high),
            habit.completed.range(low..=high).count() as i64,
        ),
        None => (0, 0),
    }
}

/// Streaks over completed days. Days after `today` are ignored.
pub fn streaks<'a>(days: impl IntoIterator<Item = &'a Date>, today: Date) -> Streaks {
    let (mut previous, mut run, mut longest): (Option<Date>, i64, i64) = (None, 0, 0);
    for &day in days {
        if day > today {
            break;
        }
        run = if previous.is_some_and(|p| p.tomorrow().is_ok_and(|next| next == day)) {
            run + 1
        } else {
            1
        };
        longest = longest.max(run);
        previous = Some(day);
    }
    let yesterday = today.yesterday().unwrap_or(today);
    Streaks {
        current: if previous.is_some_and(|last| last >= yesterday) {
            run
        } else {
            0
        },
        longest,
    }
}

fn buckets(
    habits: &[&HabitDays],
    from: Date,
    to: Date,
    today: Date,
    end_of: impl Fn(Date) -> Date,
) -> Vec<Bucket> {
    let mut out = Vec::new();
    let mut start = from;
    while start <= to {
        let end = end_of(start).min(to);
        let (mut eligible, mut completed) = (0, 0);
        for habit in habits {
            let (e, c) = counts(habit, start, end, today);
            eligible += e;
            completed += c;
        }
        out.push(Bucket {
            start: start.to_string(),
            end: end.to_string(),
            counts: Counts::new(eligible, completed),
        });
        match end.tomorrow() {
            Ok(next) => start = next,
            Err(_) => break,
        }
    }
    out
}

/// A stored `YYYY-MM-DD` date. The database already refuses anything else, so
/// this reads the digits directly instead of running a general parser over
/// every completion in the workspace.
fn stored_date(text: &str) -> Option<Date> {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| {
        b[range].iter().try_fold(0i16, |n, c| {
            c.is_ascii_digit().then(|| n * 10 + i16::from(c - b'0'))
        })
    };
    Date::new(digits(0..4)?, digits(5..7)? as i8, digits(8..10)? as i8).ok()
}

/// The week and month boundaries `compute` would produce for `from..=to`,
/// with empty counts. Other readers use them to line up with habit statistics
/// without reading any habit data.
pub fn boundaries(from: Date, to: Date, today: Date) -> (Vec<Bucket>, Vec<Bucket>) {
    let stats = compute(&[], None, from, to, today);
    (stats.weeks, stats.months)
}

/// All statistics for `from..=to`. `selected` limits habits (`None` is all of
/// them); the practice streak always covers every habit.
pub fn compute(
    every: &[HabitDays],
    selected: Option<&HashSet<String>>,
    from: Date,
    to: Date,
    today: Date,
) -> HabitStatistics {
    let chosen: Vec<&HabitDays> = every
        .iter()
        .filter(|habit| selected.is_none_or(|ids| ids.contains(&habit.id)))
        .collect();
    let (mut eligible, mut completed) = (0, 0);
    let habits = chosen
        .iter()
        .map(|habit| {
            let (e, c) = counts(habit, from, to, today);
            eligible += e;
            completed += c;
            HabitSummary {
                habit_id: habit.id.clone(),
                name: habit.name.clone(),
                archived: habit.archived_on.is_some(),
                counts: Counts::new(e, c),
                streaks: streaks(&habit.completed, today),
            }
        })
        .collect();
    let practice_days: BTreeSet<Date> = every
        .iter()
        .flat_map(|habit| habit.completed.iter().copied())
        .collect();
    HabitStatistics {
        today: today.to_string(),
        from: from.to_string(),
        to: to.to_string(),
        through: to.min(today).to_string(),
        summary: Counts::new(eligible, completed),
        habits,
        days: if day_count(from, to) <= 366 {
            buckets(&chosen, from, to, today, |start| start)
        } else {
            Vec::new()
        },
        weeks: buckets(&chosen, from, to, today, |start| {
            let to_sunday = 7 - i64::from(start.weekday().to_monday_one_offset());
            start.checked_add(to_sunday.days()).unwrap_or(Date::MAX)
        }),
        months: buckets(&chosen, from, to, today, Date::last_of_month),
        practice: streaks(&practice_days, today),
    }
}

/// Loads the workspace's history and computes the statistics for the period.
pub async fn statistics(
    pool: &SqlitePool,
    workspace: &str,
    from: &str,
    to: &str,
    habit_ids: Option<&[String]>,
    today: &str,
) -> Result<HabitStatistics, HabitError> {
    let (from, to, today) = (valid_date(from)?, valid_date(to)?, valid_date(today)?);
    if from > to || day_count(from, to) > MAX_DAYS {
        return Err(HabitError::InvalidRange);
    }
    let habits: Vec<Habit> = list(pool, workspace).await?;
    let selected = habit_ids.map(|ids| ids.iter().cloned().collect::<HashSet<_>>());
    if let Some(ids) = &selected {
        if ids
            .iter()
            .any(|id| habits.iter().all(|habit| &habit.id != id))
        {
            return Err(HabitError::NotFound);
        }
    }
    let mut done: HashMap<String, BTreeSet<Date>> = HashMap::new();
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT habit_id, date FROM habit_completions WHERE workspace_id = ?")
            .bind(workspace)
            .fetch_all(pool)
            .await
            .map_err(storage_failed)?;
    for (id, date) in rows {
        if let Some(date) = stored_date(&date) {
            done.entry(id).or_default().insert(date);
        }
    }
    let every: Vec<HabitDays> = habits
        .into_iter()
        .map(|habit| {
            Ok(HabitDays {
                completed: done.remove(&habit.id).unwrap_or_default(),
                start: valid_date(&habit.start_date)?,
                archived_on: habit.archived_on.as_deref().map(valid_date).transpose()?,
                id: habit.id,
                name: habit.name,
            })
        })
        .collect::<Result<_, HabitError>>()?;
    Ok(compute(&every, selected.as_ref(), from, to, today))
}

#[tauri::command]
pub async fn get_habit_statistics(
    instances: State<'_, DbInstances>,
    from: String,
    to: String,
    habit_ids: Option<Vec<String>>,
) -> Result<HabitStatistics, HabitError> {
    let (pool, workspace) = scope(&instances).await?;
    statistics(
        &pool,
        &workspace,
        &from,
        &to,
        habit_ids.as_deref(),
        &super::local_today(),
    )
    .await
}
