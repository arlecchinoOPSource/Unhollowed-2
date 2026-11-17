//! Recurring events, expanded only inside the requested window, and
//! changes to single occurrences. docs/CALENDAR.md describes the rules.
//!
//! - Rules follow iCalendar (RFC 5545) semantics for `FREQ`, `INTERVAL`,
//!   `COUNT`, and `UNTIL`. Monthly and yearly rules repeat the start's day,
//!   and months or years without that day are skipped rather than clamped,
//!   so a monthly event on the 31st happens only in 31-day months, and one
//!   on 29 February only in leap years. `COUNT` counts real occurrences.
//! - Timed series repeat their wall-clock time and duration in their own
//!   zone, resolving each occurrence with the compatible gap and fold rule.
//! - An occurrence is identified by its original start, `YYYY-MM-DD` or the
//!   wall-clock `YYYY-MM-DDTHH:MM` in the event's zone. Exceptions are keyed
//!   by it, so a moved occurrence keeps its identity.

use super::{
    blank, clean_text, event_timing, get_event_on, scope, set_dates, set_times, time, CalendarItem,
    Event, EventInput, EventRow, ItemKind, SchedulingError, Timing, Window, EVENT_FIELDS,
};
use jiff::civil::{Date, DateTime};
use jiff::{Timestamp, ToSpan};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use std::collections::{HashMap, HashSet};
use tauri::State;
use tauri_plugin_sql::DbInstances;
use uuid::Uuid;

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
/// A safety bound on the steps one expansion may take.
const MAX_STEPS: u32 = 50_000;

/// A repeat rule as the editor sends it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepeatRule {
    /// `daily`, `weekly`, `monthly`, or `yearly`.
    pub freq: String,
    /// Every 1 to 99 units.
    pub interval: i64,
    /// Stop after this many occurrences, 1 to 999.
    pub count: Option<i64>,
    /// Stop after this date, inclusive. Not with `count`.
    pub until: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// A validated rule.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Rule {
    pub freq: Freq,
    pub interval: i64,
    pub count: Option<i64>,
    pub until: Option<Date>,
}

impl Freq {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "daily" => Some(Self::Daily),
            "weekly" => Some(Self::Weekly),
            "monthly" => Some(Self::Monthly),
            "yearly" => Some(Self::Yearly),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
            Self::Yearly => "yearly",
        }
    }
}

/// The first day of a span.
fn first_day(timing: &Timing) -> Date {
    match timing {
        Timing::AllDay { start, .. } => *start,
        Timing::Timed { start_local, .. } => time::wall_clock(start_local).unwrap().date(),
    }
}

/// Checks a repeat rule against the event's start.
pub(crate) fn validate(
    rule: &Option<RepeatRule>,
    timing: &Timing,
) -> Result<Option<Rule>, SchedulingError> {
    let Some(rule) = rule else {
        return Ok(None);
    };
    let freq = Freq::parse(&rule.freq).ok_or(SchedulingError::InvalidRepeat)?;
    if !(1..=99).contains(&rule.interval)
        || rule.count.is_some_and(|count| !(1..=999).contains(&count))
        || (rule.count.is_some() && rule.until.is_some())
    {
        return Err(SchedulingError::InvalidRepeat);
    }
    let until = match &rule.until {
        Some(until) => {
            let until = time::date(until).ok_or(SchedulingError::InvalidRepeat)?;
            if until < first_day(timing) {
                return Err(SchedulingError::InvalidRepeat);
            }
            Some(until)
        }
        None => None,
    };
    Ok(Some(Rule {
        freq,
        interval: rule.interval,
        count: rule.count,
        until,
    }))
}

/// The rule stored on an event, if it recurs.
pub(crate) fn rule_of(event: &Event) -> Option<Rule> {
    Some(Rule {
        freq: Freq::parse(event.repeat_freq.as_deref()?)?,
        interval: event.repeat_interval?,
        count: event.repeat_count,
        until: event.repeat_until.as_deref().and_then(time::date),
    })
}

pub(crate) fn rule_columns(
    rule: &Option<Rule>,
) -> (
    Option<&'static str>,
    Option<i64>,
    Option<i64>,
    Option<String>,
) {
    match rule {
        Some(rule) => (
            Some(rule.freq.name()),
            Some(rule.interval),
            rule.count,
            rule.until.map(|until| until.to_string()),
        ),
        None => (None, None, None, None),
    }
}

/// The date of step `n`, or `None` when that month or year has no such day.
fn nth(base: Date, rule: &Rule, n: i64) -> Option<Date> {
    let k = n.checked_mul(rule.interval)?;
    match rule.freq {
        Freq::Daily => base.checked_add(k.days()).ok(),
        Freq::Weekly => base.checked_add(k.checked_mul(7)?.days()).ok(),
        Freq::Monthly => {
            let months = i64::from(base.year()) * 12 + i64::from(base.month()) - 1 + k;
            let year = i16::try_from(months.div_euclid(12)).ok()?;
            let month = (months.rem_euclid(12) + 1) as i8;
            Date::new(year, month, base.day()).ok()
        }
        Freq::Yearly => {
            let year = i16::try_from(i64::from(base.year()) + k).ok()?;
            Date::new(year, base.month(), base.day()).ok()
        }
    }
}

/// One occurrence, in the series' representation.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Occurrence {
    /// The original start, which identifies the occurrence.
    pub key: String,
    /// Zero-based position among the series' real occurrences.
    pub ordinal: i64,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Span {
    Dates {
        start: Date,
        end: Date,
    },
    Times {
        start_local: DateTime,
        end_local: DateTime,
        start_at: Timestamp,
        end_at: Timestamp,
    },
}

impl Span {
    fn overlaps(&self, window: &Window) -> bool {
        match self {
            Self::Dates { start, end } => *start < window.to && *end > window.from,
            Self::Times {
                start_at, end_at, ..
            } => *start_at < window.end && *end_at > window.start,
        }
    }

    fn starts_after(&self, window: &Window) -> bool {
        match self {
            Self::Dates { start, .. } => *start >= window.to,
            Self::Times { start_at, .. } => *start_at >= window.end,
        }
    }
}

/// The parts of a series that expansion needs.
pub(crate) struct Series {
    rule: Rule,
    base: Date,
    zone: Option<jiff::tz::TimeZone>,
    /// All-day length in days, or the start's time and the timed length in
    /// minutes, measured on the wall clock so DST does not change it.
    shape: Shape,
}

enum Shape {
    Dates { days: i64 },
    Times { hour: i8, minute: i8, minutes: i64 },
}

impl Series {
    pub(crate) fn of(event: &Event) -> Option<Self> {
        let rule = rule_of(event)?;
        if event.all_day {
            let start = time::date(event.start_date.as_deref()?)?;
            let end = time::date(event.end_date.as_deref()?)?;
            Some(Self {
                rule,
                base: start,
                zone: None,
                shape: Shape::Dates {
                    days: (end - start).get_days() as i64,
                },
            })
        } else {
            let start = time::wall_clock(event.start_local.as_deref()?)?;
            let end = time::wall_clock(event.end_local.as_deref()?)?;
            let minutes = (end
                .to_zoned(jiff::tz::TimeZone::UTC)
                .ok()?
                .timestamp()
                .as_second()
                - start
                    .to_zoned(jiff::tz::TimeZone::UTC)
                    .ok()?
                    .timestamp()
                    .as_second())
                / 60;
            Some(Self {
                rule,
                base: start.date(),
                zone: Some(time::zone(event.time_zone.as_deref()?)?),
                shape: Shape::Times {
                    hour: start.hour(),
                    minute: start.minute(),
                    minutes,
                },
            })
        }
    }

    /// The occurrence starting on `day`.
    fn at(&self, day: Date, ordinal: i64) -> Option<Occurrence> {
        match self.shape {
            Shape::Dates { days } => Some(Occurrence {
                key: day.to_string(),
                ordinal,
                span: Span::Dates {
                    start: day,
                    end: day.checked_add(days.days()).ok()?,
                },
            }),
            Shape::Times {
                hour,
                minute,
                minutes,
            } => {
                let zone = self.zone.as_ref()?;
                let start_local = day.at(hour, minute, 0, 0);
                let end_local = start_local.checked_add(minutes.minutes()).ok()?;
                let start_at = time::resolve(start_local, zone)?;
                let mut end_at = time::resolve(end_local, zone)?;
                // A start pushed forward by a daylight-saving gap can pass
                // the end. The occurrence still happens, and keeps its
                // scheduled length in elapsed time.
                if end_at <= start_at {
                    end_at = start_at.checked_add(minutes.minutes()).ok()?;
                }
                Some(Occurrence {
                    key: start_local.strftime("%Y-%m-%dT%H:%M").to_string(),
                    ordinal,
                    span: Span::Times {
                        start_local,
                        end_local,
                        start_at,
                        end_at,
                    },
                })
            }
        }
    }

    fn length_days(&self) -> i64 {
        match self.shape {
            Shape::Dates { days } => days,
            Shape::Times { minutes, .. } => minutes / 1440 + 1,
        }
    }

    /// Occurrences overlapping the window, in order, at most `limit`.
    pub(crate) fn expand(&self, window: &Window, limit: usize) -> Vec<Occurrence> {
        let step_days = match self.rule.freq {
            Freq::Daily => self.rule.interval,
            Freq::Weekly => self.rule.interval * 7,
            _ => 0,
        };
        // Daily and weekly steps never skip, so jump close to the window.
        // Monthly and yearly steps can skip, so count from the start.
        let mut n = if step_days > 0 {
            let gap = (window.from - self.base).get_days() as i64 - self.length_days() - 2;
            (gap / step_days).max(0)
        } else {
            0
        };
        let mut ordinal = n;
        let mut found = Vec::new();
        for _ in 0..MAX_STEPS {
            if self.rule.count.is_some_and(|count| ordinal >= count) {
                break;
            }
            let Some(day) = nth(self.base, &self.rule, n) else {
                if step_days > 0 {
                    break;
                }
                n += 1;
                continue;
            };
            n += 1;
            if self.rule.until.is_some_and(|until| day > until) {
                break;
            }
            let Some(occurrence) = self.at(day, ordinal) else {
                ordinal += 1;
                continue;
            };
            ordinal += 1;
            if occurrence.span.starts_after(window) {
                break;
            }
            if occurrence.span.overlaps(window) {
                found.push(occurrence);
                if found.len() >= limit {
                    break;
                }
            }
        }
        found
    }

    /// The occurrence with this key, if the series has one.
    pub(crate) fn find(&self, key: &str) -> Option<Occurrence> {
        let day = time::date(key.split('T').next()?)?;
        let zone = self.zone.clone().unwrap_or(jiff::tz::TimeZone::UTC);
        let from = time::add_days(day, -1)?;
        let to = time::add_days(day, 2)?;
        let window = Window {
            from,
            to,
            start: time::start_of_day(from, &zone)?,
            end: time::start_of_day(to, &zone)?,
            start_at: String::new(),
            end_at: String::new(),
            zone,
        };
        self.expand(&window, 8)
            .into_iter()
            .find(|occurrence| occurrence.key == key)
    }
}

#[derive(Clone, Debug, FromRow)]
pub(crate) struct ExceptionRow {
    pub event_id: String,
    pub occurrence: String,
    pub canceled: bool,
    pub title: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub url: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub start_local: Option<String>,
    pub end_local: Option<String>,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
}

const EXCEPTION_FIELDS: &str =
    "event_id, occurrence, canceled, title, description, location, url, \
     start_date, end_date, start_local, end_local, start_at, end_at";

impl ExceptionRow {
    fn moved(&self) -> Option<Span> {
        if let (Some(start), Some(end)) = (&self.start_date, &self.end_date) {
            return Some(Span::Dates {
                start: time::date(start)?,
                end: time::date(end)?,
            });
        }
        Some(Span::Times {
            start_local: time::wall_clock(self.start_local.as_deref()?)?,
            end_local: time::wall_clock(self.end_local.as_deref()?)?,
            start_at: time::parse_instant(self.start_at.as_deref()?)?,
            end_at: time::parse_instant(self.end_at.as_deref()?)?,
        })
    }
}

fn occurrence_item(
    event: &Event,
    color: &str,
    key: &str,
    span: &Span,
    exception: Option<&ExceptionRow>,
    window: &Window,
) -> CalendarItem {
    let title = exception
        .and_then(|row| row.title.clone())
        .unwrap_or_else(|| event.title.clone());
    let mut item = blank(ItemKind::Event, format!("{}:{key}", event.id), title);
    match span {
        Span::Dates { start, end } => set_dates(&mut item, &start.to_string(), &end.to_string()),
        Span::Times {
            start_local,
            end_local,
            start_at,
            end_at,
        } => set_times(
            &mut item,
            event.time_zone.as_deref().unwrap_or_default(),
            (
                &start_local.strftime("%Y-%m-%dT%H:%M").to_string(),
                &end_local.strftime("%Y-%m-%dT%H:%M").to_string(),
            ),
            (&time::instant(*start_at), &time::instant(*end_at)),
            window,
        ),
    }
    item.event_id = Some(event.id.clone());
    item.occurrence = Some(key.to_owned());
    item.recurring = true;
    item.calendar_id = Some(event.calendar_id.clone());
    item.color = Some(color.to_owned());
    item
}

/// Occurrences of the workspace's visible recurring events in the window,
/// with each occurrence's changes applied.
pub(crate) async fn occurrences(
    conn: &mut SqliteConnection,
    workspace: &str,
    window: &Window,
    limit: usize,
) -> Result<Vec<CalendarItem>, SchedulingError> {
    occurrences_of(conn, workspace, window, limit, None).await
}

/// Like `occurrences`, for only the named events when `only` is set. `limit`
/// applies to each series.
pub(crate) async fn occurrences_of(
    conn: &mut SqliteConnection,
    workspace: &str,
    window: &Window,
    limit: usize,
    only: Option<&HashSet<String>>,
) -> Result<Vec<CalendarItem>, SchedulingError> {
    let event_fields = EVENT_FIELDS
        .split(", ")
        .map(|field| format!("e.{}", field.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let mut series: Vec<EventRow> = sqlx::query_as(&format!(
        "SELECT {event_fields}, c.color FROM events AS e
         JOIN calendars AS c ON c.id = e.calendar_id
         WHERE e.workspace_id = ? AND e.repeat_freq IS NOT NULL
           AND c.archived_at IS NULL AND c.hidden = 0
           AND ((e.all_day = 0 AND e.start_at < ?) OR (e.all_day = 1 AND e.start_date < ?))"
    ))
    .bind(workspace)
    .bind(&window.end_at)
    .bind(window.to.to_string())
    .fetch_all(&mut *conn)
    .await?;
    if let Some(only) = only {
        series.retain(|row| only.contains(&row.event.id));
    }
    if series.is_empty() {
        return Ok(Vec::new());
    }
    let exception_fields = EXCEPTION_FIELDS
        .split(", ")
        .map(|field| format!("x.{}", field.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let exceptions: Vec<ExceptionRow> = sqlx::query_as(&format!(
        "SELECT {exception_fields} FROM event_exceptions AS x
         JOIN events AS e ON e.id = x.event_id
         WHERE e.workspace_id = ? AND e.repeat_freq IS NOT NULL"
    ))
    .bind(workspace)
    .fetch_all(&mut *conn)
    .await?;
    let mut by_event: HashMap<&str, HashMap<&str, &ExceptionRow>> = HashMap::new();
    for row in &exceptions {
        by_event
            .entry(row.event_id.as_str())
            .or_default()
            .insert(row.occurrence.as_str(), row);
    }

    let mut items = Vec::new();
    for EventRow { event, color } in &series {
        let Some(series_shape) = Series::of(event) else {
            continue;
        };
        let changes = by_event.get(event.id.as_str());
        let change = |key: &str| changes.and_then(|map| map.get(key).copied());
        let mut seen = HashSet::new();
        for occurrence in series_shape.expand(window, limit) {
            seen.insert(occurrence.key.clone());
            let exception = change(&occurrence.key);
            if exception.is_some_and(|row| row.canceled) {
                continue;
            }
            let span = exception
                .and_then(ExceptionRow::moved)
                .unwrap_or(occurrence.span.clone());
            if span.overlaps(window) {
                items.push(occurrence_item(
                    event,
                    color,
                    &occurrence.key,
                    &span,
                    exception,
                    window,
                ));
            }
        }
        // Occurrences moved into the window from outside it.
        for row in changes.into_iter().flat_map(|map| map.values()) {
            if row.canceled || seen.contains(&row.occurrence) {
                continue;
            }
            let Some(span) = row.moved().filter(|span| span.overlaps(window)) else {
                continue;
            };
            if series_shape.find(&row.occurrence).is_some() {
                items.push(occurrence_item(
                    event,
                    color,
                    &row.occurrence,
                    &span,
                    Some(row),
                    window,
                ));
            }
        }
    }
    Ok(items)
}

/// Deletes exceptions whose occurrence the series no longer has, after the
/// series' timing or rule changed. Returns how many were removed.
pub(crate) async fn prune(
    conn: &mut SqliteConnection,
    event: &Event,
) -> Result<usize, SchedulingError> {
    let keys: Vec<String> =
        sqlx::query_scalar("SELECT occurrence FROM event_exceptions WHERE event_id = ?")
            .bind(&event.id)
            .fetch_all(&mut *conn)
            .await?;
    let series = Series::of(event);
    let mut removed = 0;
    for key in keys {
        if series
            .as_ref()
            .and_then(|series| series.find(&key))
            .is_none()
        {
            sqlx::query("DELETE FROM event_exceptions WHERE event_id = ? AND occurrence = ?")
                .bind(&event.id)
                .bind(&key)
                .execute(&mut *conn)
                .await?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Loads a recurring event and one of its occurrences.
async fn occurrence_of(
    conn: &mut SqliteConnection,
    workspace: &str,
    id: &str,
    key: &str,
) -> Result<(Event, Series, Occurrence), SchedulingError> {
    let event = get_event_on(conn, workspace, id).await?;
    let series = Series::of(&event).ok_or(SchedulingError::NotRecurring)?;
    let occurrence = series
        .find(key)
        .ok_or(SchedulingError::OccurrenceNotFound)?;
    Ok((event, series, occurrence))
}

/// Changes one occurrence: its text and, optionally, its time. It keeps its
/// identity, and the rest of the series is unchanged. The occurrence stays
/// all-day or timed like its series, in the series' zone and calendar.
pub async fn update_occurrence(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    key: &str,
    mut input: EventInput,
) -> Result<(), SchedulingError> {
    clean_text(&mut input)?;
    let timing = event_timing(&input)?;
    let mut tx = pool.begin().await?;
    let (event, _, occurrence) = occurrence_of(&mut tx, workspace, id, key).await?;
    if input.all_day != event.all_day {
        return Err(SchedulingError::OccurrenceKind);
    }
    if let Timing::Timed { zone, .. } = &timing {
        if Some(zone) != event.time_zone.as_ref() {
            return Err(SchedulingError::InvalidTimeZone);
        }
    }
    let differs = |value: &Option<String>, series: &Option<String>| {
        (value != series).then(|| value.clone()).flatten()
    };
    let title = (input.title != event.title).then(|| input.title.clone());
    let description = (input.description != event.description).then(|| input.description.clone());
    let location = differs(&input.location, &event.location);
    let url = differs(&input.url, &event.url);
    let moved = match (&timing, &occurrence.span) {
        (Timing::AllDay { start, end }, Span::Dates { start: s, end: e })
            if start == s && end == e =>
        {
            None
        }
        (
            Timing::Timed {
                start_at, end_at, ..
            },
            Span::Times {
                start_at: s,
                end_at: e,
                ..
            },
        ) if start_at == s && end_at == e => None,
        _ => Some(timing),
    };
    let (start_date, end_date, start_local, end_local, start_at, end_at) = match &moved {
        Some(Timing::AllDay { start, end }) => (
            Some(start.to_string()),
            Some(end.to_string()),
            None,
            None,
            None,
            None,
        ),
        Some(Timing::Timed {
            start_local,
            end_local,
            start_at,
            end_at,
            ..
        }) => (
            None,
            None,
            Some(start_local.clone()),
            Some(end_local.clone()),
            Some(time::instant(*start_at)),
            Some(time::instant(*end_at)),
        ),
        None => (None, None, None, None, None, None),
    };
    sqlx::query(&format!(
        "INSERT INTO event_exceptions (event_id, occurrence, canceled, title, description, location, url,
             start_date, end_date, start_local, end_local, start_at, end_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id, occurrence) DO UPDATE SET canceled = 0, title = excluded.title,
             description = excluded.description, location = excluded.location, url = excluded.url,
             start_date = excluded.start_date, end_date = excluded.end_date,
             start_local = excluded.start_local, end_local = excluded.end_local,
             start_at = excluded.start_at, end_at = excluded.end_at, updated_at = {NOW}"
    ))
    .bind(id)
    .bind(key)
    .bind(title)
    .bind(description)
    .bind(location)
    .bind(url)
    .bind(start_date)
    .bind(end_date)
    .bind(start_local)
    .bind(end_local)
    .bind(start_at)
    .bind(end_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Cancels one occurrence. The rest of the series is unchanged.
pub async fn cancel_occurrence(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    key: &str,
) -> Result<(), SchedulingError> {
    let mut tx = pool.begin().await?;
    occurrence_of(&mut tx, workspace, id, key).await?;
    sqlx::query(&format!(
        "INSERT INTO event_exceptions (event_id, occurrence, canceled) VALUES (?, ?, 1)
         ON CONFLICT (event_id, occurrence) DO UPDATE SET canceled = 1, updated_at = {NOW}"
    ))
    .bind(id)
    .bind(key)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Restores an occurrence to the series' values, undoing a cancellation,
/// move, or edit.
pub async fn restore_occurrence(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    key: &str,
) -> Result<(), SchedulingError> {
    let mut tx = pool.begin().await?;
    occurrence_of(&mut tx, workspace, id, key).await?;
    sqlx::query("DELETE FROM event_exceptions WHERE event_id = ? AND occurrence = ?")
        .bind(id)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Ends a series just before an occurrence: by its count when it has one,
/// otherwise with a last date the day before. Removes the exceptions of the
/// occurrences that no longer happen.
async fn end_before(
    conn: &mut SqliteConnection,
    event: &Event,
    occurrence: &Occurrence,
) -> Result<(), SchedulingError> {
    let day = time::date(occurrence.key.split('T').next().unwrap_or_default())
        .ok_or(SchedulingError::InvalidDate)?;
    let (count, until) = if event.repeat_count.is_some() {
        (Some(occurrence.ordinal), None)
    } else {
        (None, time::add_days(day, -1).map(|day| day.to_string()))
    };
    sqlx::query(&format!(
        "UPDATE events SET repeat_count = ?, repeat_until = ?, updated_at = {NOW} WHERE id = ?"
    ))
    .bind(count)
    .bind(until)
    .bind(&event.id)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM event_exceptions WHERE event_id = ? AND occurrence >= ?")
        .bind(&event.id)
        .bind(&occurrence.key)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The result of changing this and following occurrences.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitResult {
    /// The original series, now ending before the occurrence, or edited in
    /// place when the occurrence was its first.
    pub series: Event,
    /// The new series that starts at the occurrence.
    pub created: Option<Event>,
    /// Changes to later occurrences carried over to the new series.
    pub kept_changes: usize,
    /// Changes to later occurrences that could not be carried over because
    /// the new series repeats differently.
    pub dropped_changes: usize,
}

/// Applies `input` to an occurrence and every later one, by ending the
/// series before it and starting a new series from it. Later occurrences'
/// changes move to the new series when it repeats with the same frequency
/// and interval, shifted by the same amount as the occurrence. Otherwise
/// they cannot be matched, are removed, and are counted in the result.
pub async fn split(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    key: &str,
    mut input: EventInput,
) -> Result<SplitResult, SchedulingError> {
    clean_text(&mut input)?;
    let timing = event_timing(&input)?;
    let rule = validate(&input.repeat, &timing)?;
    let mut tx = pool.begin().await?;
    let (event, old_series, occurrence) = occurrence_of(&mut tx, workspace, id, key).await?;
    if occurrence.ordinal == 0 {
        drop(tx);
        let series = super::events::update(pool, workspace, id, input).await?;
        return Ok(SplitResult {
            series,
            created: None,
            kept_changes: 0,
            dropped_changes: 0,
        });
    }
    let calendar = match input.calendar_id.clone() {
        Some(calendar) if calendar != event.calendar_id => {
            super::writable_calendar(&mut tx, workspace, &calendar).await?;
            calendar
        }
        _ => event.calendar_id.clone(),
    };
    // Later occurrences' changes, before the old series ends.
    let later: Vec<ExceptionRow> = sqlx::query_as(&format!(
        "SELECT {EXCEPTION_FIELDS} FROM event_exceptions WHERE event_id = ? AND occurrence >= ?"
    ))
    .bind(id)
    .bind(key)
    .fetch_all(&mut *tx)
    .await?;
    end_before(&mut tx, &event, &occurrence).await?;

    let created_id = Uuid::new_v4().to_string();
    let (freq, interval, count, until) = rule_columns(&rule);
    let query = sqlx::query(
        "INSERT INTO events (id, workspace_id, calendar_id, title, description, location, url,
             all_day, start_date, end_date, time_zone, start_local, end_local, start_at, end_at,
             repeat_freq, repeat_interval, repeat_count, repeat_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&created_id)
    .bind(workspace)
    .bind(&calendar)
    .bind(&input.title)
    .bind(&input.description)
    .bind(&input.location)
    .bind(&input.url);
    super::bind_timing(query, &timing)
        .bind(freq)
        .bind(interval)
        .bind(count)
        .bind(until)
        .execute(&mut *tx)
        .await?;
    let created = get_event_on(&mut tx, workspace, &created_id).await?;

    // Carry later changes over when the new series steps the same way.
    let (mut kept, mut dropped) = (0, 0);
    let same_steps = rule.as_ref().is_some_and(|rule| {
        rule.freq == old_series.rule.freq && rule.interval == old_series.rule.interval
    });
    let new_series = Series::of(&created);
    let shift = |old_key: &str| -> Option<String> {
        let first_new = match &timing {
            Timing::AllDay { start, .. } => start.to_string(),
            Timing::Timed { start_local, .. } => start_local.clone(),
        };
        if old_key.contains('T') {
            let delta = time::wall_clock(&first_new)?
                .since(time::wall_clock(key)?)
                .ok()?;
            let moved = time::wall_clock(old_key)?.checked_add(delta).ok()?;
            Some(moved.strftime("%Y-%m-%dT%H:%M").to_string())
        } else {
            let delta = (time::date(&first_new)? - time::date(key)?).get_days();
            Some(time::add_days(time::date(old_key)?, delta)?.to_string())
        }
    };
    for row in later {
        let new_key = same_steps
            .then(|| shift(&row.occurrence))
            .flatten()
            .filter(|new_key| {
                new_key.contains('T') == !created.all_day
                    && new_series
                        .as_ref()
                        .and_then(|series| series.find(new_key))
                        .is_some()
            });
        let Some(new_key) = new_key else {
            dropped += 1;
            continue;
        };
        sqlx::query(
            "INSERT INTO event_exceptions (event_id, occurrence, canceled, title, description, location, url,
                 start_date, end_date, start_local, end_local, start_at, end_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&created_id)
        .bind(&new_key)
        .bind(row.canceled)
        .bind(&row.title)
        .bind(&row.description)
        .bind(&row.location)
        .bind(&row.url)
        .bind(&row.start_date)
        .bind(&row.end_date)
        .bind(&row.start_local)
        .bind(&row.end_local)
        .bind(&row.start_at)
        .bind(&row.end_at)
        .execute(&mut *tx)
        .await?;
        kept += 1;
    }
    let series = get_event_on(&mut tx, workspace, id).await?;
    tx.commit().await?;
    Ok(SplitResult {
        series,
        created: Some(created),
        kept_changes: kept,
        dropped_changes: dropped,
    })
}

/// Deletes an occurrence and every later one. From the first occurrence
/// this deletes the whole event. Returns the shortened series, if any.
pub async fn end_series(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    key: &str,
) -> Result<Option<Event>, SchedulingError> {
    let mut tx = pool.begin().await?;
    let (event, _, occurrence) = occurrence_of(&mut tx, workspace, id, key).await?;
    if occurrence.ordinal == 0 {
        sqlx::query("DELETE FROM events WHERE id = ? AND workspace_id = ?")
            .bind(id)
            .bind(workspace)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(None);
    }
    end_before(&mut tx, &event, &occurrence).await?;
    let event = get_event_on(&mut tx, workspace, id).await?;
    tx.commit().await?;
    Ok(Some(event))
}

#[tauri::command]
pub async fn update_event_occurrence(
    instances: State<'_, DbInstances>,
    id: String,
    occurrence: String,
    input: EventInput,
) -> Result<(), SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    update_occurrence(&pool, &workspace, &id, &occurrence, input).await
}

#[tauri::command]
pub async fn cancel_event_occurrence(
    instances: State<'_, DbInstances>,
    id: String,
    occurrence: String,
) -> Result<(), SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    cancel_occurrence(&pool, &workspace, &id, &occurrence).await
}

#[tauri::command]
pub async fn restore_event_occurrence(
    instances: State<'_, DbInstances>,
    id: String,
    occurrence: String,
) -> Result<(), SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    restore_occurrence(&pool, &workspace, &id, &occurrence).await
}

#[tauri::command]
pub async fn split_event_series(
    instances: State<'_, DbInstances>,
    id: String,
    occurrence: String,
    input: EventInput,
) -> Result<SplitResult, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    split(&pool, &workspace, &id, &occurrence, input).await
}

#[tauri::command]
pub async fn end_event_series(
    instances: State<'_, DbInstances>,
    id: String,
    occurrence: String,
) -> Result<Option<Event>, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    end_series(&pool, &workspace, &id, &occurrence).await
}

#[cfg(test)]
mod tests;
