//! Mood, energy, and focus trends over recorded check-ins. docs/DATA_MODEL.md
//! ("Check-in analytics") defines every number.
//!
//! Each metric is summarized from the days that rated it, and nothing else:
//! a day without a rating is a gap, never a zero, and the sample count always
//! travels with the average. Metrics are never combined into a score. The
//! optional habit side uses the habit statistics engine for the same weeks and
//! months, so the two line up by construction. Nothing here claims that one
//! thing causes another.

use super::{list, valid_date, Checkin, CheckinError};
use crate::database::{active_workspace, pool};
use crate::habits::stats::{statistics, Counts};
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::BTreeMap;
use tauri::State;
use tauri_plugin_sql::DbInstances;

/// One metric over a period: how many days rated it, and their mean.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    pub samples: i64,
    /// 1 to 5. `None`, not zero, when no day in the period rated it.
    pub average: Option<f64>,
}

fn metric(values: impl Iterator<Item = i64>) -> Metric {
    let (samples, sum) = values.fold((0, 0), |(n, total), value| (n + 1, total + value));
    Metric {
        samples,
        average: (samples > 0).then(|| sum as f64 / samples as f64),
    }
}

/// One recorded day. A rating the user left unset is `None`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub date: String,
    pub mood: Option<i64>,
    pub energy: Option<i64>,
    pub focus: Option<i64>,
}

/// A week (Monday to Sunday) or calendar month inside the period, clipped to it.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub start: String,
    pub end: String,
    pub mood: Metric,
    pub energy: Metric,
    pub focus: Metric,
    /// Habit consistency over the same days, only when asked for.
    pub habits: Option<Counts>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analytics {
    pub from: String,
    pub to: String,
    /// The last day counted: the period's end, or today if that is earlier.
    pub through: String,
    /// Days in `from..=through`, the most days that could have a check-in.
    pub days_in_period: i64,
    /// Days in the period with any check-in.
    pub days_recorded: i64,
    pub mood: Metric,
    pub energy: Metric,
    pub focus: Metric,
    /// Recorded days only, oldest first. Days not listed are gaps.
    pub points: Vec<Point>,
    pub weeks: Vec<Period>,
    pub months: Vec<Period>,
    pub habits: Option<Counts>,
}

fn period(days: &[&Checkin], start: &str, end: &str, habits: Option<Counts>) -> Period {
    let within = || {
        days.iter()
            .filter(|c| c.date.as_str() >= start && c.date.as_str() <= end)
    };
    Period {
        start: start.to_owned(),
        end: end.to_owned(),
        mood: metric(within().filter_map(|c| c.mood)),
        energy: metric(within().filter_map(|c| c.energy)),
        focus: metric(within().filter_map(|c| c.focus)),
        habits,
    }
}

/// Analytics for `from..=to`. With `with_habits`, each week and month also
/// carries the habit consistency for the same days.
pub async fn analytics(
    pool: &SqlitePool,
    workspace: &str,
    from: &str,
    to: &str,
    with_habits: bool,
    today: &str,
) -> Result<Analytics, CheckinError> {
    let (first, last, now) = (valid_date(from)?, valid_date(to)?, valid_date(today)?);
    let checkins = list(pool, workspace, from, to).await?;
    // The habit engine defines the week and month boundaries for both sides.
    let habit_side = statistics(pool, workspace, from, to, None, today).await?;
    let days: Vec<&Checkin> = checkins.iter().collect();
    let through = last.min(now);
    let days_in_period = if first > through {
        0
    } else {
        first
            .until(through)
            .map_or(0, |span| span.get_days() as i64)
            + 1
    };
    let periods = |buckets: &[crate::habits::stats::Bucket]| {
        buckets
            .iter()
            .map(|bucket| {
                period(
                    &days,
                    &bucket.start,
                    &bucket.end,
                    with_habits.then_some(bucket.counts),
                )
            })
            .collect::<Vec<_>>()
    };
    let by_date: BTreeMap<&str, &Checkin> = days.iter().map(|c| (c.date.as_str(), *c)).collect();
    Ok(Analytics {
        from: from.to_owned(),
        to: to.to_owned(),
        through: through.to_string(),
        days_in_period,
        days_recorded: by_date.len() as i64,
        mood: metric(days.iter().filter_map(|c| c.mood)),
        energy: metric(days.iter().filter_map(|c| c.energy)),
        focus: metric(days.iter().filter_map(|c| c.focus)),
        points: by_date
            .values()
            .map(|c| Point {
                date: c.date.clone(),
                mood: c.mood,
                energy: c.energy,
                focus: c.focus,
            })
            .collect(),
        weeks: periods(&habit_side.weeks),
        months: periods(&habit_side.months),
        habits: with_habits.then_some(habit_side.summary),
    })
}

#[tauri::command]
pub async fn get_checkin_analytics(
    instances: State<'_, DbInstances>,
    from: String,
    to: String,
    with_habits: bool,
) -> Result<Analytics, CheckinError> {
    let instance = pool(&instances).await?;
    let workspace = active_workspace(&instance).await?;
    analytics(
        &instance,
        &workspace.id,
        &from,
        &to,
        with_habits,
        &super::local_today(),
    )
    .await
}
