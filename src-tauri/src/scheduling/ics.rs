//! iCalendar (RFC 5545) import and export of events.
//!
//! Supported: `SUMMARY`, `DESCRIPTION`, `LOCATION`, `URL`, all-day and timed
//! `DTSTART`/`DTEND`/`DURATION` with `TZID` (IANA names), UTC, or floating
//! times, `RRULE` with `FREQ`, `INTERVAL`, `COUNT`, and `UNTIL`, `EXDATE`,
//! and `RECURRENCE-ID` overrides of one occurrence. Everything else is named
//! in the report and not imported. docs/CALENDAR.md has the rules.
//!
//! An import runs in one transaction. A preview runs the same code and rolls
//! back, so it reports exactly what applying would do. An event that cannot
//! be imported is skipped whole with a reason, and a storage failure rolls
//! back the file. Input is bounded in size, events, and line length.

use super::recurrence::{self, RepeatRule};
use super::{create_event_on, scope, time, Event, EventInput, SchedulingError, EVENT_FIELDS};
use jiff::civil::{Date, DateTime};
use jiff::{Timestamp, ToSpan};
use serde::Serialize;
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::BTreeMap;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_sql::DbInstances;

/// The largest file read or written.
pub const MAX_BYTES: usize = 5 * 1024 * 1024;
/// The most events one file may contain.
pub const MAX_EVENTS: usize = 20_000;

const PRODUCT: &str = "-//Unhollowed 2//Calendar//EN";
const UID_SUFFIX: &str = "@unhollowed-2";

// --- Text format -----------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
struct Prop {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Prop {
    fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Joins folded lines: a line starting with a space or tab continues the
/// one before it.
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        match (line.strip_prefix([' ', '\t']), lines.last_mut()) {
            (Some(rest), Some(last)) => last.push_str(rest),
            _ => lines.push(line.to_owned()),
        }
    }
    lines.retain(|line| !line.is_empty());
    lines
}

fn parse_line(line: &str) -> Option<Prop> {
    // The name and parameters end at the first colon outside quotes.
    let mut quoted = false;
    let mut split = None;
    for (index, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ':' if !quoted => {
                split = Some(index);
                break;
            }
            _ => {}
        }
    }
    let split = split?;
    let (head, value) = (&line[..split], &line[split + 1..]);
    let mut parts = Vec::new();
    let (mut start, mut quoted) = (0, false);
    for (index, c) in head.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ';' if !quoted => {
                parts.push(&head[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&head[start..]);
    let name = parts[0].trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let params = parts[1..]
        .iter()
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            Some((
                key.trim().to_ascii_uppercase(),
                value.trim().trim_matches('"').to_owned(),
            ))
        })
        .collect();
    Some(Prop {
        name,
        params,
        value: value.to_owned(),
    })
}

fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\r' => {}
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out
}

/// Folds a line at 75 octets, never inside a character.
fn fold(line: &str, out: &mut String) {
    let mut width = 0;
    for c in line.chars() {
        let size = c.len_utf8();
        if width + size > 75 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(c);
        width += size;
    }
    out.push_str("\r\n");
}

// --- Reading ---------------------------------------------------------------

struct RawEvent {
    props: Vec<Prop>,
}

#[derive(Default)]
struct Parsed {
    events: Vec<RawEvent>,
    /// Components that are not events, by name, with counts.
    ignored_components: BTreeMap<String, usize>,
    /// Properties that are read but not imported, by name, with counts.
    ignored_props: BTreeMap<String, usize>,
    warnings: Vec<String>,
}

/// Properties of an event that are understood.
const KNOWN: [&str; 14] = [
    "UID",
    "SUMMARY",
    "DESCRIPTION",
    "LOCATION",
    "URL",
    "DTSTART",
    "DTEND",
    "DURATION",
    "RRULE",
    "EXDATE",
    "RECURRENCE-ID",
    "DTSTAMP",
    "STATUS",
    "TRANSP",
];
/// Understood and deliberately not an import, so not worth a note.
const QUIET: [&str; 7] = [
    "DTSTAMP",
    "SEQUENCE",
    "CREATED",
    "LAST-MODIFIED",
    "PRODID",
    "X-WR-CALNAME",
    "TRANSP",
];

fn parse(text: &str) -> Result<Parsed, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines = unfold(text);
    if lines
        .first()
        .map(|line| line.trim().to_ascii_uppercase())
        .as_deref()
        != Some("BEGIN:VCALENDAR")
    {
        return Err("This is not an iCalendar file. It must start with BEGIN:VCALENDAR.".into());
    }
    let mut parsed = Parsed::default();
    let mut stack: Vec<String> = Vec::new();
    let mut current: Option<RawEvent> = None;
    for line in &lines {
        if line.chars().count() > 20_000 {
            return Err("The file has a line that is far too long to be a calendar.".into());
        }
        let Some(prop) = parse_line(line) else {
            parsed
                .warnings
                .push(format!("Skipped an unreadable line: {}", preview(line)));
            continue;
        };
        match prop.name.as_str() {
            "BEGIN" => {
                let name = prop.value.trim().to_ascii_uppercase();
                if stack.len() >= 4 {
                    return Err("The calendar is nested too deeply.".into());
                }
                if name == "VEVENT" && stack.len() == 1 {
                    if parsed.events.len() >= MAX_EVENTS {
                        return Err(format!(
                            "The file has more than {MAX_EVENTS} events. Split it and import the parts."
                        ));
                    }
                    current = Some(RawEvent { props: Vec::new() });
                } else if stack.len() == 1 || (stack.len() >= 2 && current.is_none()) {
                    *parsed.ignored_components.entry(name.clone()).or_default() += 1;
                } else if current.is_some() {
                    *parsed.ignored_components.entry(name.clone()).or_default() += 1;
                }
                stack.push(name);
            }
            "END" => {
                let name = prop.value.trim().to_ascii_uppercase();
                if stack.pop().as_deref() != Some(name.as_str()) {
                    return Err("The calendar's BEGIN and END lines do not match.".into());
                }
                if name == "VEVENT" && stack.len() == 1 {
                    if let Some(event) = current.take() {
                        parsed.events.push(event);
                    }
                }
            }
            _ => {
                // Properties belong to the innermost component. Only those
                // directly in a VEVENT are read.
                let direct = stack.len() == 2 && stack[1] == "VEVENT";
                match (&mut current, direct) {
                    (Some(event), true) => {
                        if !KNOWN.contains(&prop.name.as_str())
                            && !QUIET.contains(&prop.name.as_str())
                        {
                            *parsed.ignored_props.entry(prop.name.clone()).or_default() += 1;
                        }
                        event.props.push(prop);
                    }
                    _ => {}
                }
            }
        }
    }
    if !stack.is_empty() {
        return Err("The file ends before its calendar is closed with END:VCALENDAR.".into());
    }
    Ok(parsed)
}

fn preview(line: &str) -> String {
    line.chars().take(40).collect()
}

/// A date or an instant read from a property.
#[derive(Clone, Debug)]
enum Moment {
    Date(Date),
    Zoned {
        zone: String,
        local: DateTime,
        at: Timestamp,
    },
}

fn parse_date(value: &str) -> Option<Date> {
    if value.len() != 8 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Date::new(
        value[0..4].parse().ok()?,
        value[4..6].parse().ok()?,
        value[6..8].parse().ok()?,
    )
    .ok()
}

fn parse_moment(prop: &Prop, floating: &str) -> Result<Moment, String> {
    let value = prop.value.trim();
    if prop
        .param("VALUE")
        .is_some_and(|kind| kind.eq_ignore_ascii_case("DATE"))
        || value.len() == 8
    {
        return parse_date(value)
            .map(Moment::Date)
            .ok_or_else(|| format!("{} is not a valid date.", prop.name));
    }
    let (body, utc) = match value.strip_suffix(['Z', 'z']) {
        Some(body) => (body, true),
        None => (value, false),
    };
    let bad = || format!("{} is not a valid date and time.", prop.name);
    if body.len() != 15 || body.as_bytes()[8] != b'T' {
        return Err(bad());
    }
    let date = parse_date(&body[0..8]).ok_or_else(bad)?;
    let part = |range: std::ops::Range<usize>| body[range].parse::<i8>().map_err(|_| bad());
    let local = date.at(part(9..11)?, part(11..13)?, part(13..15)?, 0);
    let local = DateTime::from(local);
    let zone = if utc {
        "UTC".to_owned()
    } else {
        match prop.param("TZID") {
            Some(name) if time::zone(name).is_some() => name.to_owned(),
            Some(name) => {
                return Err(format!(
                    "The time zone {name:?} is not an IANA zone name this app knows."
                ))
            }
            None => floating.to_owned(),
        }
    };
    let tz = time::zone(&zone).ok_or_else(|| format!("The time zone {zone:?} is not known."))?;
    let at = time::resolve(local, &tz).ok_or_else(bad)?;
    Ok(Moment::Zoned { zone, local, at })
}

/// The wall-clock key an occurrence has in a series, or why it has none.
fn occurrence_key(moment: &Moment, series_zone: Option<&str>) -> Result<String, String> {
    match (moment, series_zone) {
        (Moment::Date(date), None) => Ok(date.to_string()),
        (Moment::Zoned { at, .. }, Some(zone)) => {
            let tz = time::zone(zone).ok_or("unknown zone")?;
            Ok(time::local(*at, &tz))
        }
        _ => Err("it does not match the series' all-day or timed form".into()),
    }
}

fn parse_duration(value: &str) -> Option<jiff::SignedDuration> {
    let (negative, rest) = match value.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, value.strip_prefix('+').unwrap_or(value)),
    };
    let rest = rest.strip_prefix('P')?;
    let mut seconds: i64 = 0;
    let mut number = String::new();
    let mut in_time = false;
    for c in rest.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => number.push(c),
            unit => {
                let n: i64 = number.parse().ok()?;
                number.clear();
                seconds += n * match (unit, in_time) {
                    ('W', false) => 604_800,
                    ('D', false) => 86_400,
                    ('H', true) => 3_600,
                    ('M', true) => 60,
                    ('S', true) => 1,
                    _ => return None,
                };
            }
        }
    }
    if !number.is_empty() || seconds == 0 {
        return None;
    }
    Some(jiff::SignedDuration::from_secs(if negative {
        -seconds
    } else {
        seconds
    }))
}

fn find<'a>(event: &'a RawEvent, name: &str) -> Option<&'a Prop> {
    event.props.iter().find(|prop| prop.name == name)
}

fn text(event: &RawEvent, name: &str) -> Option<String> {
    find(event, name).map(|prop| unescape(&prop.value))
}

/// An event as the importer understands it, before it is stored.
struct Converted {
    input: EventInput,
    /// The series' zone, for timed events.
    zone: Option<String>,
}

fn rule_of(
    prop: &Prop,
    zone: Option<&str>,
    all_day: bool,
    floating: &str,
    warnings: &mut Vec<String>,
) -> Result<RepeatRule, String> {
    let mut freq = None;
    let mut interval = 1;
    let mut count = None;
    let mut until = None;
    for part in prop.value.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            return Err(format!("The repeat rule {:?} is not valid.", prop.value));
        };
        match key.to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match value.to_ascii_uppercase().as_str() {
                    "DAILY" => "daily",
                    "WEEKLY" => "weekly",
                    "MONTHLY" => "monthly",
                    "YEARLY" => "yearly",
                    other => return Err(format!("The repeat frequency {other} is not supported.")),
                })
            }
            "INTERVAL" => {
                interval = value
                    .parse()
                    .map_err(|_| "The repeat interval is not a number.")?
            }
            "COUNT" => {
                count = Some(
                    value
                        .parse()
                        .map_err(|_| "The repeat count is not a number.")?,
                )
            }
            "UNTIL" => {
                let probe = Prop {
                    name: "UNTIL".into(),
                    params: prop
                        .params
                        .iter()
                        .filter(|(key, _)| key == "TZID")
                        .cloned()
                        .collect(),
                    value: value.to_owned(),
                };
                until = Some(match parse_moment(&probe, floating)? {
                    Moment::Date(date) => date,
                    Moment::Zoned { at, local, .. } => {
                        // The last date an occurrence may start on.
                        if let (false, Some(zone)) = (all_day, zone) {
                            let tz = time::zone(zone).ok_or("unknown zone")?;
                            let shown = time::local(at, &tz);
                            if !shown.ends_with("23:59") {
                                warnings
                                    .push("An UNTIL time was kept as its whole day.".to_owned());
                            }
                            time::wall_clock(&shown)
                                .map(|w| w.date())
                                .ok_or("bad until")?
                        } else {
                            local.date()
                        }
                    }
                });
            }
            "WKST" => {}
            other => {
                return Err(format!(
                    "The repeat rule uses {other}, which is not supported."
                ))
            }
        }
    }
    let freq = freq.ok_or("The repeat rule has no FREQ.")?;
    Ok(RepeatRule {
        freq: freq.to_owned(),
        interval,
        count,
        until: until.map(|date| date.to_string()),
    })
}

fn convert(
    event: &RawEvent,
    floating: &str,
    calendar: &Option<String>,
    warnings: &mut Vec<String>,
) -> Result<Converted, String> {
    let title = text(event, "SUMMARY").unwrap_or_default();
    if title.trim().is_empty() {
        return Err("The event has no title.".into());
    }
    let start = find(event, "DTSTART").ok_or("The event has no start.")?;
    let start = parse_moment(start, floating)?;
    let end = find(event, "DTEND").map(|prop| parse_moment(prop, floating));
    let duration = find(event, "DURATION")
        .map(|prop| parse_duration(prop.value.trim()).ok_or("The DURATION is not valid."));
    let mut input = EventInput {
        calendar_id: calendar.clone(),
        title,
        description: text(event, "DESCRIPTION").unwrap_or_default(),
        location: text(event, "LOCATION"),
        url: text(event, "URL"),
        ..Default::default()
    };
    let zone = match &start {
        Moment::Date(first) => {
            let end = match (end, duration) {
                (Some(Ok(Moment::Date(last))), _) => last,
                (Some(Ok(_)), _) => return Err("An all-day start needs an all-day end.".into()),
                (Some(Err(message)), _) => return Err(message),
                (None, Some(span)) => {
                    let span = span?;
                    let days = (span.as_secs() / 86_400).max(1);
                    first
                        .checked_add(days.days())
                        .map_err(|_| "The end date is out of range.")?
                }
                (None, None) => time::add_days(*first, 1).ok_or("The end date is out of range.")?,
            };
            input.all_day = true;
            input.start_date = Some(first.to_string());
            input.end_date = Some(end.to_string());
            None
        }
        Moment::Zoned { zone, local, at } => {
            let tz = time::zone(zone).ok_or("The time zone is not known.")?;
            let end_at = match (end, duration) {
                (Some(Ok(Moment::Zoned { at, .. })), _) => at,
                (Some(Ok(Moment::Date(_))), _) => {
                    return Err("A timed start needs a timed end.".into())
                }
                (Some(Err(message)), _) => return Err(message),
                (None, Some(span)) => at
                    .checked_add(span?)
                    .map_err(|_| "The end time is out of range.")?,
                (None, None) => return Err("The event has no end or duration.".into()),
            };
            if local.second() != 0 {
                warnings.push("Seconds in a start time were dropped.".to_owned());
            }
            input.time_zone = Some(zone.clone());
            input.start = Some(time::local(*at, &tz));
            input.end = Some(time::local(end_at, &tz));
            Some(zone.clone())
        }
    };
    if let Some(rule) = find(event, "RRULE") {
        input.repeat = Some(rule_of(
            rule,
            zone.as_deref(),
            input.all_day,
            floating,
            warnings,
        )?);
    }
    Ok(Converted { input, zone })
}

// --- Report ----------------------------------------------------------------

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IcsEntry {
    pub title: String,
    pub uid: String,
    pub recurring: bool,
    /// Cancelled and changed occurrences applied to the series.
    pub exceptions: usize,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IcsIssue {
    pub title: String,
    pub uid: String,
    pub message: String,
}

/// What an import does, or did. A preview and an import return the same
/// report, and only the import has `applied` set.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IcsReport {
    /// The file cannot be imported at all, and why. Nothing changed.
    pub fatal: Option<String>,
    /// Events in the file, overrides of a series not counted.
    pub found: usize,
    pub imported: Vec<IcsEntry>,
    /// Already in the calendar by UID. They are left as they are.
    pub duplicates: Vec<IcsEntry>,
    pub skipped: Vec<IcsIssue>,
    /// Things that were not imported, or were adjusted, without skipping
    /// an event.
    pub warnings: Vec<String>,
    pub applied: bool,
}

fn explain(error: &SchedulingError) -> &'static str {
    match error {
        SchedulingError::InvalidTitle => "The title must be 1 to 200 characters.",
        SchedulingError::InvalidLocation => "The location is too long or has control characters.",
        SchedulingError::InvalidUrl => "The URL is not an http or https address.",
        SchedulingError::InvalidDescription => "The description is too long.",
        SchedulingError::InvalidRepeat => {
            "The repeat rule is outside what is supported, such as an interval over 99 or a count over 999."
        }
        SchedulingError::InvalidRange => "The end is not after the start, or it is over a year long.",
        SchedulingError::InvalidDate | SchedulingError::InvalidTime => "A date or time is not valid.",
        SchedulingError::InvalidTimeZone => "The time zone is not valid.",
        SchedulingError::CalendarNotFound | SchedulingError::NotFound => {
            "The calendar to import into is not available."
        }
        _ => "The event could not be stored.",
    }
}

// --- Import ----------------------------------------------------------------

/// The ID of an event already carrying this UID, if any.
async fn existing(
    conn: &mut SqliteConnection,
    workspace: &str,
    uid: &str,
) -> Result<Option<String>, SchedulingError> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM events WHERE workspace_id = ?1 AND (ics_uid = ?2 OR id || ?3 = ?2) LIMIT 1",
    )
    .bind(workspace)
    .bind(uid)
    .bind(UID_SUFFIX)
    .fetch_optional(&mut *conn)
    .await?)
}

pub async fn import(
    pool: &SqlitePool,
    workspace: &str,
    content: &str,
    calendar: Option<String>,
    floating_zone: &str,
    commit: bool,
) -> Result<IcsReport, SchedulingError> {
    let mut report = IcsReport::default();
    if content.len() > MAX_BYTES {
        report.fatal = Some("The file is over 5 MiB, which is more than a calendar needs.".into());
        return Ok(report);
    }
    if time::zone(floating_zone).is_none() {
        return Err(SchedulingError::InvalidTimeZone);
    }
    let parsed = match parse(content) {
        Ok(parsed) => parsed,
        Err(message) => {
            report.fatal = Some(message);
            return Ok(report);
        }
    };
    for (name, count) in &parsed.ignored_components {
        report.warnings.push(match name.as_str() {
            "VTIMEZONE" => "Time zone definitions (VTIMEZONE) were ignored. Zones are matched by their IANA names.".to_owned(),
            "VALARM" => format!("{count} alarm(s) (VALARM) were ignored. Set reminders in the app."),
            _ => format!("{count} {name} component(s) are not supported and were ignored."),
        });
    }
    for (name, count) in &parsed.ignored_props {
        report.warnings.push(format!(
            "{name} is not supported and was ignored in {count} event(s)."
        ));
    }
    report.warnings.extend(parsed.warnings.iter().cloned());

    // Group by UID: the series, then its overrides.
    let mut order: Vec<String> = Vec::new();
    let mut groups: BTreeMap<String, (Vec<&RawEvent>, Vec<&RawEvent>)> = BTreeMap::new();
    for (index, event) in parsed.events.iter().enumerate() {
        let uid = text(event, "UID")
            .map(|uid| uid.trim().to_owned())
            .filter(|uid| !uid.is_empty() && uid.len() <= 255)
            .unwrap_or_else(|| format!("no-uid-{index}"));
        if !groups.contains_key(&uid) {
            order.push(uid.clone());
        }
        let group = groups.entry(uid).or_default();
        if find(event, "RECURRENCE-ID").is_some() {
            group.1.push(event);
        } else {
            group.0.push(event);
        }
    }
    report.found = groups.values().map(|(masters, _)| masters.len()).sum();

    let mut tx = pool.begin().await?;
    for uid in order {
        let (masters, overrides) = &groups[&uid];
        let title_of = |event: &RawEvent| text(event, "SUMMARY").unwrap_or_default();
        let Some(master) = masters.first() else {
            for event in overrides {
                report.skipped.push(IcsIssue {
                    title: title_of(event),
                    uid: uid.clone(),
                    message: "This changes one occurrence of a series that is not in the file."
                        .into(),
                });
            }
            continue;
        };
        if masters.len() > 1 {
            report.warnings.push(format!(
                "{} events share the UID {uid:?}. Only the first was read.",
                masters.len()
            ));
        }
        let title = title_of(master);
        let entry = |converted: Option<&Converted>, exceptions| IcsEntry {
            title: title.clone(),
            uid: uid.clone(),
            recurring: converted.is_some_and(|c| c.input.repeat.is_some()),
            exceptions,
        };
        let status = text(master, "STATUS").unwrap_or_default();
        if status.eq_ignore_ascii_case("CANCELLED") {
            report.skipped.push(IcsIssue {
                title,
                uid,
                message: "The event is marked cancelled.".into(),
            });
            continue;
        }
        if existing(&mut tx, workspace, &uid).await?.is_some() {
            report.duplicates.push(entry(None, 0));
            continue;
        }
        let mut notes = Vec::new();
        let converted = match convert(master, floating_zone, &calendar, &mut notes) {
            Ok(converted) => converted,
            Err(message) => {
                report.skipped.push(IcsIssue {
                    title,
                    uid,
                    message,
                });
                continue;
            }
        };
        report.warnings.extend(notes);
        let event = match create_event_on(&mut tx, workspace, converted.input.clone()).await {
            Ok(event) => event,
            Err(SchedulingError::StorageFailed) => return Err(SchedulingError::StorageFailed),
            Err(error) => {
                report.skipped.push(IcsIssue {
                    title,
                    uid,
                    message: explain(&error).into(),
                });
                continue;
            }
        };
        sqlx::query("UPDATE events SET ics_uid = ? WHERE id = ?")
            .bind(&uid)
            .bind(&event.id)
            .execute(&mut *tx)
            .await?;
        let applied = apply_exceptions(
            &mut tx,
            workspace,
            &event,
            master,
            overrides,
            &converted,
            floating_zone,
            &mut report.warnings,
        )
        .await?;
        report.imported.push(entry(Some(&converted), applied));
    }
    if commit && report.fatal.is_none() {
        tx.commit().await?;
        report.applied = true;
    }
    Ok(report)
}

#[allow(clippy::too_many_arguments)]
async fn apply_exceptions(
    tx: &mut SqliteConnection,
    workspace: &str,
    event: &Event,
    master: &RawEvent,
    overrides: &[&RawEvent],
    converted: &Converted,
    floating: &str,
    warnings: &mut Vec<String>,
) -> Result<usize, SchedulingError> {
    let mut applied = 0;
    let zone = converted.zone.as_deref();
    let label = &event.title;
    let recurring = converted.input.repeat.is_some();
    let ex = master
        .props
        .iter()
        .filter(|prop| prop.name == "EXDATE")
        .flat_map(|prop| {
            prop.value.split(',').map(|value| Prop {
                name: prop.name.clone(),
                params: prop.params.clone(),
                value: value.to_owned(),
            })
        })
        .collect::<Vec<_>>();
    if !recurring && (!ex.is_empty() || !overrides.is_empty()) {
        warnings.push(format!(
            "{label}: exceptions were ignored because the event does not repeat."
        ));
        return Ok(0);
    }
    for prop in ex {
        let key = parse_moment(&prop, floating).and_then(|m| occurrence_key(&m, zone));
        match key {
            Ok(key) => match recurrence::cancel_occurrence_on(tx, workspace, &event.id, &key).await
            {
                Ok(()) => applied += 1,
                Err(SchedulingError::OccurrenceNotFound) => warnings.push(format!(
                    "{label}: the EXDATE {} is not an occurrence of the series and was ignored.",
                    prop.value
                )),
                Err(error) => return Err(error),
            },
            Err(message) => warnings.push(format!("{label}: an EXDATE was ignored: {message}")),
        }
    }
    for over in overrides {
        let Some(id) = find(over, "RECURRENCE-ID") else {
            continue;
        };
        if id.param("RANGE").is_some() {
            warnings.push(format!(
                "{label}: an override for this and following occurrences is not supported and was ignored."
            ));
            continue;
        }
        let key = parse_moment(id, floating).and_then(|m| occurrence_key(&m, zone));
        let mut notes = Vec::new();
        let one = convert(over, floating, &None, &mut notes);
        let (key, one) = match (key, one) {
            (Ok(key), Ok(one)) => (key, one),
            (Err(message), _) | (_, Err(message)) => {
                warnings.push(format!(
                    "{label}: a changed occurrence was ignored: {message}"
                ));
                continue;
            }
        };
        warnings.extend(notes);
        let mut input = one.input;
        input.repeat = None;
        // The occurrence keeps the series' zone and calendar.
        if let (Some(series), Some(own)) = (zone, input.time_zone.clone()) {
            if own != series {
                let tz = time::zone(series).ok_or(SchedulingError::InvalidTimeZone)?;
                let to = |wall: &Option<String>| -> Option<String> {
                    let local = time::wall_clock(wall.as_deref()?)?;
                    let from = time::zone(&own)?;
                    Some(time::local(time::resolve(local, &from)?, &tz))
                };
                input.start = to(&input.start);
                input.end = to(&input.end);
                input.time_zone = Some(series.to_owned());
            }
        }
        match recurrence::update_occurrence_on(tx, workspace, &event.id, &key, input).await {
            Ok(()) => applied += 1,
            Err(SchedulingError::StorageFailed) => return Err(SchedulingError::StorageFailed),
            Err(error) => warnings.push(format!(
                "{label}: a changed occurrence was ignored. {}",
                explain(&error)
            )),
        }
    }
    Ok(applied)
}

// --- Export ----------------------------------------------------------------

fn compact(value: &str) -> String {
    value.replace(['-', ':'], "")
}

/// `DTSTART`-style property for a date or a wall-clock time.
fn stamp(name: &str, date_only: bool, value: &str, zone: Option<&str>) -> String {
    let body = compact(value);
    match (date_only, zone) {
        (true, _) => format!("{name};VALUE=DATE:{}", &body[..8]),
        (false, Some("UTC")) | (false, None) => format!("{name}:{body}00Z"),
        (false, Some(zone)) => format!("{name};TZID={zone}:{body}00"),
    }
}

fn utc_stamp(moment: &str) -> String {
    moment
        .parse::<Timestamp>()
        .map(|at| at.strftime("%Y%m%dT%H%M%SZ").to_string())
        .unwrap_or_else(|_| "19700101T000000Z".to_owned())
}

#[derive(sqlx::FromRow)]
struct ExceptionRow {
    event_id: String,
    occurrence: String,
    canceled: bool,
    title: Option<String>,
    description: Option<String>,
    location: Option<String>,
    url: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
    start_local: Option<String>,
    end_local: Option<String>,
}

pub async fn export(
    pool: &SqlitePool,
    workspace: &str,
) -> Result<(String, usize), SchedulingError> {
    let events: Vec<Event> = sqlx::query_as(&format!(
        "SELECT {EVENT_FIELDS} FROM events WHERE workspace_id = ? ORDER BY start_at, start_date, title, id"
    ))
    .bind(workspace)
    .fetch_all(pool)
    .await?;
    let uids: BTreeMap<String, Option<String>> = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, ics_uid FROM events WHERE workspace_id = ?",
    )
    .bind(workspace)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let exceptions: Vec<ExceptionRow> = sqlx::query_as(
        "SELECT x.event_id, x.occurrence, x.canceled, x.title, x.description, x.location, x.url,
                x.start_date, x.end_date, x.start_local, x.end_local
         FROM event_exceptions AS x JOIN events AS e ON e.id = x.event_id
         WHERE e.workspace_id = ? ORDER BY x.occurrence",
    )
    .bind(workspace)
    .fetch_all(pool)
    .await?;

    let mut out = String::new();
    for line in [
        "BEGIN:VCALENDAR".to_owned(),
        "VERSION:2.0".to_owned(),
        format!("PRODID:{PRODUCT}"),
        "CALSCALE:GREGORIAN".to_owned(),
    ] {
        fold(&line, &mut out);
    }
    for event in &events {
        let uid = uids
            .get(&event.id)
            .cloned()
            .flatten()
            .unwrap_or_else(|| format!("{}{UID_SUFFIX}", event.id));
        let mine: Vec<&ExceptionRow> = exceptions
            .iter()
            .filter(|x| x.event_id == event.id)
            .collect();
        write_event(&mut out, event, &uid, &mine)?;
    }
    fold("END:VCALENDAR", &mut out);
    Ok((out, events.len()))
}

fn text_lines(
    event: &Event,
    title: &str,
    description: &str,
    location: &Option<String>,
    url: &Option<String>,
) -> Vec<String> {
    let _ = event;
    let mut lines = vec![format!("SUMMARY:{}", escape(title))];
    if !description.is_empty() {
        lines.push(format!("DESCRIPTION:{}", escape(description)));
    }
    if let Some(location) = location {
        lines.push(format!("LOCATION:{}", escape(location)));
    }
    if let Some(url) = url {
        lines.push(format!("URL:{url}"));
    }
    lines
}

fn write_event(
    out: &mut String,
    event: &Event,
    uid: &str,
    exceptions: &[&ExceptionRow],
) -> Result<(), SchedulingError> {
    let zone = event.time_zone.as_deref();
    let mut lines = vec![
        "BEGIN:VEVENT".to_owned(),
        format!("UID:{uid}"),
        format!("DTSTAMP:{}", utc_stamp(&event.updated_at)),
    ];
    if event.all_day {
        lines.push(stamp(
            "DTSTART",
            true,
            event.start_date.as_deref().unwrap_or_default(),
            None,
        ));
        lines.push(stamp(
            "DTEND",
            true,
            event.end_date.as_deref().unwrap_or_default(),
            None,
        ));
    } else {
        lines.push(stamp(
            "DTSTART",
            false,
            event.start_local.as_deref().unwrap_or_default(),
            zone,
        ));
        lines.push(stamp(
            "DTEND",
            false,
            event.end_local.as_deref().unwrap_or_default(),
            zone,
        ));
    }
    lines.extend(text_lines(
        event,
        &event.title,
        &event.description,
        &event.location,
        &event.url,
    ));
    if let Some(rule) = recurrence::rule_of(event) {
        let mut parts = vec![
            format!(
                "FREQ={}",
                event
                    .repeat_freq
                    .as_deref()
                    .unwrap_or_default()
                    .to_ascii_uppercase()
            ),
            format!("INTERVAL={}", rule.interval),
        ];
        if let Some(count) = rule.count {
            parts.push(format!("COUNT={count}"));
        }
        if let Some(until) = rule.until {
            parts.push(format!(
                "UNTIL={}",
                until_stamp(until, event.all_day, zone)?
            ));
        }
        lines.push(format!("RRULE:{}", parts.join(";")));
    }
    for exception in exceptions.iter().filter(|x| x.canceled) {
        lines.push(stamp("EXDATE", event.all_day, &exception.occurrence, zone));
    }
    lines.push("END:VEVENT".to_owned());
    for line in lines {
        fold(&line, out);
    }
    // Changed occurrences are separate events with a RECURRENCE-ID.
    let series = recurrence::Series::of(event);
    for exception in exceptions.iter().filter(|x| !x.canceled) {
        let Some(occurrence) = series
            .as_ref()
            .and_then(|series| series.find(&exception.occurrence))
        else {
            continue;
        };
        let moved = moved_span(exception, &occurrence);
        let mut lines = vec![
            "BEGIN:VEVENT".to_owned(),
            format!("UID:{uid}"),
            format!("DTSTAMP:{}", utc_stamp(&event.updated_at)),
            stamp("RECURRENCE-ID", event.all_day, &exception.occurrence, zone),
        ];
        let (start, end) = moved;
        lines.push(stamp("DTSTART", event.all_day, &start, zone));
        lines.push(stamp("DTEND", event.all_day, &end, zone));
        lines.extend(text_lines(
            event,
            exception.title.as_deref().unwrap_or(&event.title),
            exception
                .description
                .as_deref()
                .unwrap_or(&event.description),
            &exception
                .location
                .clone()
                .or_else(|| event.location.clone()),
            &exception.url.clone().or_else(|| event.url.clone()),
        ));
        lines.push("END:VEVENT".to_owned());
        for line in lines {
            fold(&line, out);
        }
    }
    Ok(())
}

/// The start and end a changed occurrence has now, as stored text: the
/// moved times if it was moved, else the series' own for that occurrence.
fn moved_span(exception: &ExceptionRow, occurrence: &recurrence::Occurrence) -> (String, String) {
    if let (Some(start), Some(end)) = (&exception.start_date, &exception.end_date) {
        return (start.clone(), end.clone());
    }
    if let (Some(start), Some(end)) = (&exception.start_local, &exception.end_local) {
        return (start.clone(), end.clone());
    }
    match &occurrence.span {
        recurrence::Span::Dates { start, end } => (start.to_string(), end.to_string()),
        recurrence::Span::Times {
            start_local,
            end_local,
            ..
        } => (
            start_local.strftime("%Y-%m-%dT%H:%M").to_string(),
            end_local.strftime("%Y-%m-%dT%H:%M").to_string(),
        ),
    }
}

fn until_stamp(until: Date, all_day: bool, zone: Option<&str>) -> Result<String, SchedulingError> {
    if all_day {
        return Ok(compact(&until.to_string()));
    }
    // The end of the last day in the event's zone, as UTC.
    let tz = time::zone(zone.unwrap_or("UTC")).ok_or(SchedulingError::InvalidTimeZone)?;
    let next = time::add_days(until, 1).ok_or(SchedulingError::InvalidDate)?;
    let start = time::start_of_day(next, &tz).ok_or(SchedulingError::InvalidDate)?;
    let last = start
        .checked_sub(1.second())
        .map_err(|_| SchedulingError::InvalidDate)?;
    Ok(last.strftime("%Y%m%dT%H%M%SZ").to_string())
}

// --- Commands --------------------------------------------------------------

/// What a native file dialog chose.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCalendar {
    pub path: String,
    pub events: usize,
}

/// Asks for a calendar file with the native dialog and reads it. `None` when
/// the user cancels. Files over 5 MiB or not valid UTF-8 are refused.
#[tauri::command]
pub async fn pick_ics_file<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<PickedFile>, SchedulingError> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("iCalendar", &["ics"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|_| SchedulingError::FileFailed)?;
        let size = std::fs::metadata(&path)
            .map_err(|_| SchedulingError::FileFailed)?
            .len();
        if size > MAX_BYTES as u64 {
            return Err(SchedulingError::FileTooLarge);
        }
        let bytes = std::fs::read(&path).map_err(|_| SchedulingError::FileFailed)?;
        let content = String::from_utf8(bytes).map_err(|_| SchedulingError::FileFailed)?;
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(Some(PickedFile { name, content }))
    })
    .await
    .map_err(|_| SchedulingError::FileFailed)?
}

#[tauri::command]
pub async fn preview_ics_import(
    instances: State<'_, DbInstances>,
    content: String,
    calendar_id: Option<String>,
    time_zone: String,
) -> Result<IcsReport, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    import(&pool, &workspace, &content, calendar_id, &time_zone, false).await
}

#[tauri::command]
pub async fn import_ics(
    instances: State<'_, DbInstances>,
    content: String,
    calendar_id: Option<String>,
    time_zone: String,
) -> Result<IcsReport, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    import(&pool, &workspace, &content, calendar_id, &time_zone, true).await
}

/// Asks where to save with the native dialog and writes every event.
#[tauri::command]
pub async fn export_calendar_ics<R: Runtime>(
    app: AppHandle<R>,
    instances: State<'_, DbInstances>,
) -> Result<Option<SavedCalendar>, SchedulingError> {
    let (pool, workspace) = scope(&instances).await?;
    let (content, events) = export(&pool, &workspace).await?;
    if content.len() > MAX_BYTES {
        return Err(SchedulingError::FileTooLarge);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name("unhollowed-calendar.ics")
            .add_filter("iCalendar", &["ics"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|_| SchedulingError::FileFailed)?;
        std::fs::write(&path, content).map_err(|error| {
            eprintln!("Could not write {}: {error}", path.display());
            SchedulingError::FileFailed
        })?;
        Ok(Some(SavedCalendar {
            path: path.display().to_string(),
            events,
        }))
    })
    .await
    .map_err(|_| SchedulingError::FileFailed)?
}

#[cfg(test)]
mod tests;
