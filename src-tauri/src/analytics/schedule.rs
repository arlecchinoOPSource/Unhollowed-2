//! Scheduled activity: events, planned work sessions, and due dates, by local
//! day and by project. docs/ANALYTICS.md, "Schedule", defines every number.
//!
//! Everything is read through the calendar's own `list_items`, so recurring
//! events, changed and canceled occurrences, hidden and archived calendars,
//! and archived issues behave exactly as they do on the calendar, and a
//! summary reconciles with the schedule it summarizes. Minutes are *scheduled*
//! time, never time actually spent.

use super::{civil, AnalyticsError, MAX_DAYS};
use crate::database::{active_workspace, pool};
use crate::scheduling::{list_items, window, CalendarItem, ItemKind, ItemRange};
use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap};
use tauri::State;
use tauri_plugin_sql::DbInstances;

/// How far ahead "upcoming" looks: today and the next 6 days.
const UPCOMING_DAYS: i64 = 6;
const NEXT_LIMIT: usize = 10;

type Span = (i64, i64);

/// The total length of the union of the spans, in seconds.
fn union(spans: &[Span]) -> i64 {
    let mut sorted = spans.to_vec();
    sorted.sort_unstable();
    let mut total = 0;
    let mut current: Option<Span> = None;
    for (start, end) in sorted {
        current = match current {
            Some((from, to)) if start <= to => Some((from, to.max(end))),
            Some((from, to)) => {
                total += to - from;
                Some((start, end))
            }
            None => Some((start, end)),
        };
    }
    total + current.map_or(0, |(from, to)| to - from)
}

fn minutes(seconds: i64) -> i64 {
    seconds / 60
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    /// Distinct event occurrences touching the period (all-day and timed).
    pub events: i64,
    pub all_day_events: i64,
    pub timed_events: i64,
    /// Scheduled work sessions touching the period.
    pub work_blocks: i64,
    /// Open issues due in the period.
    pub deadlines: i64,
    /// Scheduled minutes of timed events, clipped to the period.
    pub event_minutes: i64,
    pub work_block_minutes: i64,
    /// Minutes covered by at least one timed event or work session.
    pub busy_minutes: i64,
    /// Minutes counted twice because items overlap:
    /// `event_minutes + work_block_minutes - busy_minutes`.
    pub overlap_minutes: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub start: String,
    pub end: String,
    #[serde(flatten)]
    pub load: Load,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLoad {
    /// `project`, `unassigned` (no project), or `shared` (event linked to
    /// more than one project).
    pub kind: String,
    pub project_id: Option<String>,
    pub name: String,
    pub events: i64,
    pub event_minutes: i64,
    pub work_blocks: i64,
    pub work_block_minutes: i64,
    pub deadlines: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upcoming {
    pub events: i64,
    pub work_blocks: i64,
    pub deadlines: i64,
    pub next: Vec<NextItem>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextItem {
    /// `event`, `work_block`, or `deadline`.
    pub kind: String,
    pub id: String,
    pub title: String,
    pub all_day: bool,
    /// Wall-clock start in the device zone, or the date for all-day items.
    pub when: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleAnalytics {
    pub from: String,
    pub to: String,
    pub today: String,
    pub time_zone: String,
    pub project_id: Option<String>,
    /// More items matched than the calendar returns: counts are lower bounds.
    pub truncated: bool,
    pub totals: Load,
    pub days: Vec<Bucket>,
    pub weeks: Vec<Bucket>,
    pub projects: Vec<ProjectLoad>,
    /// As of today, whatever the period.
    pub upcoming: Upcoming,
}

fn kind_name(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Event => "event",
        ItemKind::WorkBlock => "work_block",
        ItemKind::Deadline => "deadline",
    }
}

fn instant(value: &Option<String>) -> Option<i64> {
    value
        .as_deref()
        .and_then(|text| text.parse::<Timestamp>().ok())
        .map(|stamp| stamp.as_second())
}

fn day_start(day: Date, zone: &TimeZone) -> Option<i64> {
    let zoned = day.to_zoned(zone.clone()).ok()?;
    Some(zoned.start_of_day().ok()?.timestamp().as_second())
}

/// A day's accumulated spans and counts.
#[derive(Default)]
struct Day {
    events: Vec<Span>,
    blocks: Vec<Span>,
    all_day: i64,
    timed: i64,
    work_blocks: i64,
    deadlines: i64,
}

impl Day {
    fn load(&self) -> Load {
        let (e, b) = (
            self.events.iter().map(|(s, t)| t - s).sum::<i64>(),
            self.blocks.iter().map(|(s, t)| t - s).sum::<i64>(),
        );
        let all: Vec<Span> = self.events.iter().chain(&self.blocks).copied().collect();
        let busy = union(&all);
        Load {
            events: self.all_day + self.timed,
            all_day_events: self.all_day,
            timed_events: self.timed,
            work_blocks: self.work_blocks,
            deadlines: self.deadlines,
            event_minutes: minutes(e),
            work_block_minutes: minutes(b),
            busy_minutes: minutes(busy),
            overlap_minutes: minutes(e + b) - minutes(busy),
        }
    }
}

#[derive(Default)]
struct Owner {
    events: i64,
    event_seconds: i64,
    work_blocks: i64,
    work_block_seconds: i64,
    deadlines: i64,
}

/// The pieces of a timed item on each local day of `[from, to]`, in seconds
/// since the epoch. DST is handled by measuring real instants, so a day that
/// is 23 or 25 hours long contributes its true length.
fn segments((start, end): Span, (first, last): (Date, Date), zone: &TimeZone) -> Vec<(Date, Span)> {
    let mut out = Vec::new();
    let mut day = first;
    while day <= last {
        let Some(from) = day_start(day, zone) else {
            break;
        };
        let next = day.tomorrow().ok();
        let to = next.and_then(|n| day_start(n, zone)).unwrap_or(i64::MAX);
        let (a, b) = (start.max(from), end.min(to));
        if a < b {
            out.push((day, (a, b)));
        }
        match next {
            Some(n) if from < end => day = n,
            _ => break,
        }
    }
    out
}

fn monday(date: Date) -> Date {
    let back = i64::from(date.weekday().to_monday_one_offset()) - 1;
    date.checked_add((-back).days()).unwrap_or(date)
}

/// Schedule analytics for `from..=to`, optionally for one project.
pub async fn schedule(
    pool: &SqlitePool,
    workspace: &str,
    from: &str,
    to: &str,
    project: Option<&str>,
    time_zone: &str,
    today: &str,
) -> Result<ScheduleAnalytics, AnalyticsError> {
    let (first, last, now) = (civil(from)?, civil(to)?, civil(today)?);
    let count = first.until(last).map_or(i64::MAX, |s| s.get_days() as i64) + 1;
    if first > last || count > MAX_DAYS {
        return Err(AnalyticsError::InvalidRange);
    }
    if let Some(id) = project {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?")
                .bind(id)
                .bind(workspace)
                .fetch_optional(pool)
                .await?;
        if found.is_none() {
            return Err(AnalyticsError::NotFound);
        }
    }
    let after = last
        .checked_add(1.day())
        .map_err(|_| AnalyticsError::InvalidDate)?;
    let range = ItemRange {
        from: from.to_owned(),
        to: after.to_string(),
        time_zone: time_zone.to_owned(),
    };
    let zone = window(&range)?.zone;
    let found = list_items(pool, workspace, range).await?;

    // Who each item belongs to: an issue's project, an event's linked projects.
    let issue_project: HashMap<String, Option<String>> =
        sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, project_id FROM issues WHERE workspace_id = ?",
        )
        .bind(workspace)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
    let mut event_projects: HashMap<String, Vec<String>> = HashMap::new();
    for (event, linked) in sqlx::query_as::<_, (String, String)>(
        "SELECT event_id, project_id FROM event_projects WHERE workspace_id = ? ORDER BY project_id",
    )
    .bind(workspace)
    .fetch_all(pool)
    .await?
    {
        event_projects.entry(event).or_default().push(linked);
    }
    let names: HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
        "SELECT id, name FROM projects WHERE workspace_id = ?",
    )
    .bind(workspace)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    let projects_of = |item: &CalendarItem| -> Vec<Option<String>> {
        match item.kind {
            ItemKind::Event => match item.event_id.as_ref().and_then(|id| event_projects.get(id)) {
                Some(linked) => linked.iter().cloned().map(Some).collect(),
                None => vec![None],
            },
            _ => vec![item
                .issue_id
                .as_ref()
                .and_then(|id| issue_project.get(id))
                .cloned()
                .flatten()],
        }
    };

    let mut days: BTreeMap<Date, Day> = BTreeMap::new();
    let mut owners: BTreeMap<String, (Option<String>, String, String, Owner)> = BTreeMap::new();
    let mut totals_items = Load::default();
    for item in &found.items {
        let linked = projects_of(item);
        if let Some(id) = project {
            if !linked.iter().any(|p| p.as_deref() == Some(id)) {
                continue;
            }
        }
        if item.kind == ItemKind::Deadline && item.closed {
            continue;
        }
        // One owner: the project, `unassigned`, or `shared` for 2+ projects.
        let (kind, owner_id, label) = match (project, linked.as_slice()) {
            (Some(id), _) => (
                "project",
                Some(id.to_owned()),
                names.get(id).cloned().unwrap_or_default(),
            ),
            (None, [Some(id)]) => (
                "project",
                Some(id.clone()),
                names.get(id).cloned().unwrap_or_default(),
            ),
            (None, [None]) => ("unassigned", None, "No project".to_owned()),
            (None, _) => ("shared", None, "Linked to several projects".to_owned()),
        };
        let key = format!("{kind}:{}", owner_id.clone().unwrap_or_default());
        let owner = owners
            .entry(key)
            .or_insert_with(|| (owner_id.clone(), kind.to_owned(), label, Owner::default()));

        match item.kind {
            ItemKind::Event | ItemKind::WorkBlock => {
                let is_event = item.kind == ItemKind::Event;
                if is_event {
                    totals_items.events += 1;
                    owner.3.events += 1;
                } else {
                    totals_items.work_blocks += 1;
                    owner.3.work_blocks += 1;
                }
                if item.all_day {
                    totals_items.all_day_events += 1;
                    // Each day the all-day event covers inside the period.
                    let start = item.start_date.as_deref().and_then(|d| civil(d).ok());
                    let end = item.end_date.as_deref().and_then(|d| civil(d).ok());
                    if let (Some(start), Some(end)) = (start, end) {
                        let mut day = start.max(first);
                        while day < end && day <= last {
                            days.entry(day).or_default().all_day += 1;
                            match day.tomorrow() {
                                Ok(next) => day = next,
                                Err(_) => break,
                            }
                        }
                    }
                } else if let (Some(start), Some(end)) =
                    (instant(&item.start_at), instant(&item.end_at))
                {
                    if is_event {
                        totals_items.timed_events += 1;
                    }
                    for (day, span) in segments((start, end), (first, last), &zone) {
                        let slot = days.entry(day).or_default();
                        let seconds = span.1 - span.0;
                        if is_event {
                            slot.events.push(span);
                            slot.timed += 1;
                            owner.3.event_seconds += seconds;
                        } else {
                            slot.blocks.push(span);
                            slot.work_blocks += 1;
                            owner.3.work_block_seconds += seconds;
                        }
                    }
                }
            }
            ItemKind::Deadline => {
                owner.3.deadlines += 1;
                totals_items.deadlines += 1;
                if let Some(day) = item.start_date.as_deref().and_then(|d| civil(d).ok()) {
                    days.entry(day).or_default().deadlines += 1;
                }
            }
        }
    }

    // One bucket per day of the period, including quiet days.
    let mut day_buckets = Vec::new();
    let mut day = first;
    while day <= last {
        let load = days.get(&day).map(Day::load).unwrap_or_default();
        day_buckets.push(Bucket {
            start: day.to_string(),
            end: day.to_string(),
            load,
        });
        match day.tomorrow() {
            Ok(next) => day = next,
            Err(_) => break,
        }
    }
    let mut totals = Load {
        events: totals_items.events,
        all_day_events: totals_items.all_day_events,
        timed_events: totals_items.timed_events,
        work_blocks: totals_items.work_blocks,
        deadlines: totals_items.deadlines,
        ..Load::default()
    };
    for bucket in &day_buckets {
        totals.event_minutes += bucket.load.event_minutes;
        totals.work_block_minutes += bucket.load.work_block_minutes;
        totals.busy_minutes += bucket.load.busy_minutes;
        totals.overlap_minutes += bucket.load.overlap_minutes;
    }
    // Weeks add up their days' minutes; counts are of distinct items per week.
    let mut weeks: Vec<Bucket> = Vec::new();
    for bucket in &day_buckets {
        let date = civil(&bucket.start)?;
        let week = monday(date).max(first).to_string();
        match weeks.last_mut() {
            Some(last_week) if monday(civil(&last_week.start)?) == monday(date) => {
                last_week.end = bucket.end.clone();
                let l = &mut last_week.load;
                l.event_minutes += bucket.load.event_minutes;
                l.work_block_minutes += bucket.load.work_block_minutes;
                l.busy_minutes += bucket.load.busy_minutes;
                l.overlap_minutes += bucket.load.overlap_minutes;
                l.deadlines += bucket.load.deadlines;
                l.all_day_events += bucket.load.all_day_events;
                l.timed_events += bucket.load.timed_events;
                l.events += bucket.load.events;
                l.work_blocks += bucket.load.work_blocks;
            }
            _ => weeks.push(Bucket {
                start: week,
                end: bucket.end.clone(),
                load: Load {
                    events: bucket.load.events,
                    all_day_events: bucket.load.all_day_events,
                    timed_events: bucket.load.timed_events,
                    work_blocks: bucket.load.work_blocks,
                    deadlines: bucket.load.deadlines,
                    event_minutes: bucket.load.event_minutes,
                    work_block_minutes: bucket.load.work_block_minutes,
                    busy_minutes: bucket.load.busy_minutes,
                    overlap_minutes: bucket.load.overlap_minutes,
                },
            }),
        }
    }

    let mut projects: Vec<ProjectLoad> = owners
        .into_values()
        .map(|(project_id, kind, name, owner)| ProjectLoad {
            kind,
            project_id,
            name,
            events: owner.events,
            event_minutes: minutes(owner.event_seconds),
            work_blocks: owner.work_blocks,
            work_block_minutes: minutes(owner.work_block_seconds),
            deadlines: owner.deadlines,
        })
        .collect();
    projects.sort_by(|a, b| {
        (a.kind != "project", a.name.to_lowercase(), &a.project_id).cmp(&(
            b.kind != "project",
            b.name.to_lowercase(),
            &b.project_id,
        ))
    });

    // Upcoming: today and the next 6 days, whatever the period.
    let horizon = now
        .checked_add((UPCOMING_DAYS + 1).days())
        .map_err(|_| AnalyticsError::InvalidDate)?;
    let ahead = list_items(
        pool,
        workspace,
        ItemRange {
            from: today.to_owned(),
            to: horizon.to_string(),
            time_zone: time_zone.to_owned(),
        },
    )
    .await?;
    let mut upcoming = Upcoming {
        events: 0,
        work_blocks: 0,
        deadlines: 0,
        next: Vec::new(),
    };
    for item in &ahead.items {
        let linked = projects_of(item);
        if let Some(id) = project {
            if !linked.iter().any(|p| p.as_deref() == Some(id)) {
                continue;
            }
        }
        if item.kind == ItemKind::Deadline && item.closed {
            continue;
        }
        match item.kind {
            ItemKind::Event => upcoming.events += 1,
            ItemKind::WorkBlock => upcoming.work_blocks += 1,
            ItemKind::Deadline => upcoming.deadlines += 1,
        }
        if upcoming.next.len() < NEXT_LIMIT {
            upcoming.next.push(NextItem {
                kind: kind_name(item.kind).to_owned(),
                id: item.id.clone(),
                title: item.title.clone(),
                all_day: item.all_day,
                when: if item.all_day {
                    item.start_date.clone().unwrap_or_default()
                } else {
                    item.start.clone().unwrap_or_default()
                },
            });
        }
    }

    Ok(ScheduleAnalytics {
        from: from.to_owned(),
        to: to.to_owned(),
        today: today.to_owned(),
        time_zone: time_zone.to_owned(),
        project_id: project.map(str::to_owned),
        truncated: found.truncated || ahead.truncated,
        totals,
        days: day_buckets,
        weeks,
        projects,
        upcoming,
    })
}

#[tauri::command]
pub async fn get_schedule_analytics(
    instances: State<'_, DbInstances>,
    from: String,
    to: String,
    project_id: Option<String>,
    time_zone: String,
) -> Result<ScheduleAnalytics, AnalyticsError> {
    let instance = pool(&instances).await?;
    let workspace = active_workspace(&instance).await?;
    schedule(
        &instance,
        &workspace.id,
        &from,
        &to,
        project_id.as_deref(),
        &time_zone,
        &jiff::Zoned::now().date().to_string(),
    )
    .await
}
