//! Searching and filtering calendar items.
//!
//! Search reads the same tables as `list_calendar_items` and never copies
//! them, so it cannot see another workspace and keeps nothing of its own.
//!
//! - **Order.** Results run from the viewer's `today` forward, soonest first,
//!   then continue backward through earlier items, most recent first. With no
//!   text, that is the list of upcoming items.
//! - **Matching.** Text is a literal, Unicode case-insensitive substring of an
//!   event's title or description, or of an issue's title or description for
//!   deadlines and work blocks.
//! - **Bounded work.** Each ordered stream stops after `SEARCH_LIMIT + 1`
//!   matches, so the cap is stable: the earliest-first top results are the same
//!   however large the workspace is. A recurring series is never expanded in
//!   full: it yields one result, its next occurrence within one window of
//!   `today`, or else its latest earlier one, or else its first.
//! - **Visibility.** Like calendar views, search leaves out events in hidden
//!   or archived calendars, archived issues, and (unless asked) completed ones.

use super::{
    block_item, deadline_item, event_item, recurrence, refresh_instants, scope, time, tzdb_version,
    window, BlockRow, CalendarItem, EventRow, ItemKind, ItemRange, SchedulingError, EVENT_FIELDS,
    MAX_RANGE_DAYS, WORK_BLOCK_FIELDS,
};
use crate::issues::index_missing;
use jiff::civil::Date;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::{HashMap, HashSet};
use tauri::State;
use tauri_plugin_sql::DbInstances;

/// The most results one search returns. More sets `truncated`.
pub const SEARCH_LIMIT: usize = 100;
/// The most recurring series one search follows.
const MAX_SERIES: usize = 500;
/// The longest search text. Longer text matches nothing.
const MAX_TEXT_CHARS: usize = 200;
/// Rows read per query while scanning events for text.
const CHUNK: i64 = 250;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarSearch {
    /// Matched against titles and descriptions. Blank matches everything.
    #[serde(default)]
    pub text: String,
    /// The viewer's zone, and `today` is a date in it.
    pub time_zone: String,
    pub today: String,
    /// The kinds to include. Absent means all, and an empty list means none.
    #[serde(default)]
    pub kinds: Option<Vec<ItemKind>>,
    /// Limits events to these calendars. Absent means every visible calendar,
    /// and an empty list means none. Deadlines and work blocks belong to
    /// issues, not calendars, so this does not apply to them.
    #[serde(default)]
    pub calendar_ids: Option<Vec<String>>,
    /// Includes deadlines and work blocks of done and canceled issues.
    #[serde(default)]
    pub include_completed: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    /// Upcoming items first, then earlier ones.
    pub items: Vec<CalendarItem>,
    /// How many leading items end on or after `today`.
    pub upcoming: usize,
    /// More than `SEARCH_LIMIT` matched.
    pub truncated: bool,
}

impl SearchResults {
    fn empty() -> Self {
        Self {
            items: Vec::new(),
            upcoming: 0,
            truncated: false,
        }
    }
}

/// Which events one scan reads, in the order they are wanted.
#[derive(Clone, Copy)]
enum Scan {
    Recurring,
    Timed { upcoming: bool },
    AllDay { upcoming: bool },
}

impl Scan {
    /// The condition, with the day's start in `?5`, and the order.
    fn sql(self) -> (&'static str, &'static str) {
        match self {
            Self::Recurring => ("e.repeat_freq IS NOT NULL", "e.id"),
            Self::Timed { upcoming: true } => (
                "e.repeat_freq IS NULL AND e.all_day = 0 AND e.end_at > ?5",
                "e.start_at, e.id",
            ),
            Self::Timed { upcoming: false } => (
                "e.repeat_freq IS NULL AND e.all_day = 0 AND e.end_at <= ?5",
                "e.start_at DESC, e.id",
            ),
            Self::AllDay { upcoming: true } => (
                "e.repeat_freq IS NULL AND e.all_day = 1 AND e.end_date > ?5",
                "e.start_date, e.id",
            ),
            Self::AllDay { upcoming: false } => (
                "e.repeat_freq IS NULL AND e.all_day = 1 AND e.end_date <= ?5",
                "e.start_date DESC, e.id",
            ),
        }
    }
}

fn matches(text: &str, title: &str, description: &str) -> bool {
    text.is_empty()
        || title.to_lowercase().contains(text)
        || description.to_lowercase().contains(text)
}

/// Reads matching events in order, stopping at `cap`. Events are read a
/// chunk at a time and matched in Rust, where case folding follows full
/// Unicode rules (SQLite's `lower()` only folds ASCII).
async fn scan_events(
    conn: &mut SqliteConnection,
    workspace: &str,
    search: &CalendarSearch,
    text: &str,
    scan: Scan,
    cutoff: &str,
    cap: usize,
) -> Result<Vec<EventRow>, SchedulingError> {
    let fields = EVENT_FIELDS
        .split(", ")
        .map(|field| format!("e.{}", field.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let (condition, order) = scan.sql();
    let calendars = search
        .calendar_ids
        .as_ref()
        .map(|ids| serde_json::to_string(ids).unwrap_or_else(|_| "[]".into()));
    let sql = format!(
        "SELECT {fields}, c.color FROM events AS e
         JOIN calendars AS c ON c.id = e.calendar_id
         WHERE e.workspace_id = ?1 AND c.archived_at IS NULL AND c.hidden = 0
           AND (?2 IS NULL OR e.calendar_id IN (SELECT value FROM json_each(?2)))
           AND {condition}
         ORDER BY {order} LIMIT ?3 OFFSET ?4"
    );
    // Without text every row matches, so read no more than the cap.
    let chunk = if text.is_empty() { cap as i64 } else { CHUNK };
    let mut found = Vec::new();
    let mut offset = 0;
    loop {
        let mut query = sqlx::query_as(&sql)
            .bind(workspace)
            .bind(&calendars)
            .bind(chunk)
            .bind(offset);
        if !matches!(scan, Scan::Recurring) {
            query = query.bind(cutoff);
        }
        let rows: Vec<EventRow> = query.fetch_all(&mut *conn).await?;
        let read = rows.len() as i64;
        for row in rows {
            if matches(text, &row.event.title, &row.event.description) {
                found.push(row);
                if found.len() >= cap {
                    return Ok(found);
                }
            }
        }
        if read < chunk {
            return Ok(found);
        }
        offset += chunk;
    }
}

/// Searches the calendar. See the module notes for ordering and limits.
pub async fn search_items(
    pool: &SqlitePool,
    workspace: &str,
    search: CalendarSearch,
) -> Result<SearchResults, SchedulingError> {
    let zone = time::zone(&search.time_zone).ok_or(SchedulingError::InvalidTimeZone)?;
    let today: Date = time::date(&search.today).ok_or(SchedulingError::InvalidDate)?;
    let day_start = time::start_of_day(today, &zone).ok_or(SchedulingError::InvalidDate)?;
    let text = search.text.trim().to_lowercase();
    if text.chars().count() > MAX_TEXT_CHARS || text.contains('\0') {
        return Ok(SearchResults::empty());
    }
    let wants = |kind: ItemKind| {
        search
            .kinds
            .as_ref()
            .is_none_or(|kinds| kinds.contains(&kind))
    };
    refresh_instants(pool, workspace, tzdb_version()).await?;
    if !text.is_empty() {
        index_missing(pool, workspace)
            .await
            .map_err(|_| SchedulingError::StorageFailed)?;
    }

    let day = today.to_string();
    let cutoff = time::instant(day_start);
    let horizon = |from: Date, to: Date| {
        window(&ItemRange {
            from: from.to_string(),
            to: to.to_string(),
            time_zone: search.time_zone.clone(),
        })
    };
    let days = MAX_RANGE_DAYS as i32;
    let after = time::add_days(today, days).ok_or(SchedulingError::InvalidDate)?;
    let before = time::add_days(today, -days).ok_or(SchedulingError::InvalidDate)?;
    let ahead = horizon(today, after)?;
    let behind = horizon(before, today)?;

    let cap = SEARCH_LIMIT + 1;
    let mut conn = pool.acquire().await?;
    let mut upcoming: Vec<CalendarItem> = Vec::new();
    let mut earlier: Vec<CalendarItem> = Vec::new();
    let mut truncated = false;

    if wants(ItemKind::Event)
        && search
            .calendar_ids
            .as_ref()
            .is_none_or(|ids| !ids.is_empty())
    {
        // Single events, as four ordered streams. The best `cap` of their
        // union are among the best `cap` of each.
        for (scan, ahead_of_today) in [
            (Scan::Timed { upcoming: true }, true),
            (Scan::AllDay { upcoming: true }, true),
            (Scan::Timed { upcoming: false }, false),
            (Scan::AllDay { upcoming: false }, false),
        ] {
            let rows = scan_events(
                &mut conn,
                workspace,
                &search,
                &text,
                scan,
                &cutoff_for(scan, &cutoff, &day),
                cap,
            )
            .await?;
            let target = if ahead_of_today {
                &mut upcoming
            } else {
                &mut earlier
            };
            target.extend(
                rows.into_iter()
                    .map(|row| event_item(row.event, row.color, &ahead)),
            );
        }

        // Recurring series yield one result each.
        let series = scan_events(
            &mut conn,
            workspace,
            &search,
            &text,
            Scan::Recurring,
            &cutoff,
            MAX_SERIES + 1,
        )
        .await?;
        truncated |= series.len() > MAX_SERIES;
        let series: Vec<EventRow> = series.into_iter().take(MAX_SERIES).collect();
        if !series.is_empty() {
            let ids: HashSet<String> = series.iter().map(|row| row.event.id.clone()).collect();
            // A cancelled occurrence still counts toward expansion's limit, so
            // look past as many as the busiest series has changes.
            let listed = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into());
            let changes: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(n), 0) FROM (
                     SELECT count(*) AS n FROM event_exceptions
                     WHERE event_id IN (SELECT value FROM json_each(?)) GROUP BY event_id)",
            )
            .bind(&listed)
            .fetch_one(&mut *conn)
            .await?;
            let reach = 1 + changes.clamp(0, 1000) as usize;
            let next =
                recurrence::occurrences_of(&mut conn, workspace, &ahead, reach, Some(&ids)).await?;
            let last = recurrence::occurrences_of(
                &mut conn,
                workspace,
                &behind,
                MAX_RANGE_DAYS as usize + 1,
                Some(&ids),
            )
            .await?;
            let mut chosen: HashMap<String, (bool, CalendarItem)> = HashMap::new();
            for item in next {
                let id = item.event_id.clone().unwrap_or_default();
                let better = chosen
                    .get(&id)
                    .is_none_or(|(_, held)| start_key(&item) < start_key(held));
                if better {
                    chosen.insert(id, (true, item));
                }
            }
            for item in last {
                let id = item.event_id.clone().unwrap_or_default();
                let better = match chosen.get(&id) {
                    None => true,
                    Some((true, _)) => false,
                    Some((false, held)) => start_key(&item) > start_key(held),
                };
                if better {
                    chosen.insert(id, (false, item));
                }
            }
            for EventRow { event, color } in series {
                match chosen.remove(&event.id) {
                    Some((true, item)) => upcoming.push(item),
                    Some((false, item)) => earlier.push(item),
                    None => {
                        // Ended long ago: show where the series began.
                        let mut item = event_item(event.clone(), color, &behind);
                        let key = item
                            .start_date
                            .clone()
                            .or_else(|| item.local_start.clone())
                            .unwrap_or_default();
                        item.id = format!("{}:{key}", event.id);
                        item.occurrence = Some(key);
                        item.recurring = true;
                        earlier.push(item);
                    }
                }
            }
        }
    }

    let closed_filter = if search.include_completed {
        ""
    } else {
        "AND i.status NOT IN ('done', 'canceled')"
    };
    let issue_text = "(?3 = '' OR instr(i.search_text, ?3) > 0)";

    if wants(ItemKind::Deadline) {
        for (ahead_of_today, comparison, order) in [(true, ">=", "ASC"), (false, "<", "DESC")] {
            let rows: Vec<(String, i64, String, String, bool)> = sqlx::query_as(&format!(
                "SELECT i.id, i.number, i.title, i.due_date, i.status IN ('done', 'canceled')
                 FROM issues AS i
                 WHERE i.workspace_id = ?1 AND i.archived_at IS NULL
                   AND i.due_date IS NOT NULL AND i.due_date {comparison} ?2
                   AND {issue_text} {closed_filter}
                 ORDER BY i.due_date {order}, i.number {order} LIMIT ?4"
            ))
            .bind(workspace)
            .bind(&day)
            .bind(&text)
            .bind(cap as i64)
            .fetch_all(&mut *conn)
            .await?;
            let target = if ahead_of_today {
                &mut upcoming
            } else {
                &mut earlier
            };
            target.extend(rows.into_iter().map(|(id, number, title, due, closed)| {
                deadline_item(id, number, title, &due, closed)
            }));
        }
    }

    if wants(ItemKind::WorkBlock) {
        let fields = WORK_BLOCK_FIELDS
            .split(", ")
            .map(|field| format!("b.{field}"))
            .collect::<Vec<_>>()
            .join(", ");
        for (ahead_of_today, comparison, order) in [(true, ">", "ASC"), (false, "<=", "DESC")] {
            let rows: Vec<BlockRow> = sqlx::query_as(&format!(
                "SELECT {fields}, i.title, i.number, i.status IN ('done', 'canceled') AS closed
                 FROM work_blocks AS b JOIN issues AS i ON i.id = b.issue_id
                 WHERE b.workspace_id = ?1 AND i.archived_at IS NULL
                   AND b.end_at {comparison} ?2
                   AND {issue_text} {closed_filter}
                 ORDER BY b.start_at {order}, b.id {order} LIMIT ?4"
            ))
            .bind(workspace)
            .bind(&cutoff)
            .bind(&text)
            .bind(cap as i64)
            .fetch_all(&mut *conn)
            .await?;
            let target = if ahead_of_today {
                &mut upcoming
            } else {
                &mut earlier
            };
            target.extend(rows.into_iter().map(|row| block_item(row, &ahead)));
        }
    }

    // Soonest first going forward, most recent first going back.
    super::sort_items(&mut upcoming);
    super::sort_items(&mut earlier);
    earlier.reverse();
    truncated |= upcoming.len() + earlier.len() > SEARCH_LIMIT;
    upcoming.truncate(SEARCH_LIMIT);
    earlier.truncate(SEARCH_LIMIT - upcoming.len());
    let count = upcoming.len();
    upcoming.extend(earlier);
    Ok(SearchResults {
        items: upcoming,
        upcoming: count,
        truncated,
    })
}

/// The value bound as `?5` for a scan: an instant for timed events and a
/// date for all-day ones.
fn cutoff_for<'a>(scan: Scan, instant: &'a str, day: &'a str) -> &'a str {
    match scan {
        Scan::AllDay { .. } => day,
        _ => instant,
    }
}

/// Orders items by where they start, as in a view.
fn start_key(item: &CalendarItem) -> String {
    item.start_date
        .clone()
        .or_else(|| item.start.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn search_calendar_items(
    instances: State<'_, DbInstances>,
    search: CalendarSearch,
) -> Result<SearchResults, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    search_items(&pool, &workspace, search).await
}

#[cfg(test)]
mod tests;
