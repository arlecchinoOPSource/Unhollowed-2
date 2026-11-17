//! The temporal contract for calendar items. docs/CALENDAR.md explains it.
//!
//! - Timed items keep their intent, a wall-clock `YYYY-MM-DDTHH:MM` in an
//!   IANA zone, and the UTC instants it resolves to, `YYYY-MM-DDTHH:MM:SSZ`.
//! - All-day items and issue deadlines are calendar dates, `YYYY-MM-DD`,
//!   and never pass through a time zone.
//! - Ranges are half-open: an item ending at 10:00 does not overlap one
//!   starting at 10:00.
//! - A wall-clock time inside a daylight-saving gap resolves to the same
//!   time shifted forward by the gap (02:30 becomes 03:30). A time inside a
//!   fold, which happens twice, resolves to the earlier instant. This is the
//!   "compatible" rule of RFC 5545 and JavaScript Temporal.
//!
//! The time-zone database is bundled, so results do not depend on the
//! device's zone files and work offline.

use jiff::civil::{Date, DateTime};
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan, Zoned};

/// Accepts a known IANA zone name such as `Europe/Paris` or `UTC`.
pub fn zone(name: &str) -> Option<TimeZone> {
    if name.is_empty() || name.len() > 64 {
        return None;
    }
    jiff::tz::db().get(name).ok()
}

/// Accepts a real calendar date in `YYYY-MM-DD` form.
pub fn date(value: &str) -> Option<Date> {
    if value.len() != 10 || !crate::projects::valid_date(value) {
        return None;
    }
    value.parse().ok()
}

/// Accepts a wall-clock time in `YYYY-MM-DDTHH:MM` form.
pub fn wall_clock(value: &str) -> Option<DateTime> {
    let (day, time) = value.split_once('T')?;
    date(day)?;
    let bytes = time.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    let (hour, minute) = (time[..2].parse::<i8>().ok()?, time[3..].parse::<i8>().ok()?);
    if !time[..2]
        .bytes()
        .chain(time[3..].bytes())
        .all(|b| b.is_ascii_digit())
        || !(0..24).contains(&hour)
        || !(0..60).contains(&minute)
    {
        return None;
    }
    value.parse().ok()
}

/// Resolves a wall-clock time in a zone to an instant, using the
/// compatible rule for gaps and folds.
pub fn resolve(local: DateTime, zone: &TimeZone) -> Option<Timestamp> {
    zone.to_ambiguous_zoned(local)
        .compatible()
        .ok()
        .map(|zoned| zoned.timestamp())
}

/// Formats an instant the way it is stored: UTC with second precision, so
/// stored values sort and compare as text.
pub fn instant(timestamp: Timestamp) -> String {
    timestamp.strftime("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn parse_instant(value: &str) -> Option<Timestamp> {
    value.parse().ok()
}

/// The wall-clock time of an instant in a zone, as `YYYY-MM-DDTHH:MM`.
pub fn local(timestamp: Timestamp, zone: &TimeZone) -> String {
    timestamp
        .to_zoned(zone.clone())
        .strftime("%Y-%m-%dT%H:%M")
        .to_string()
}

/// The instant a calendar day starts in a zone. Where midnight does not
/// exist, the day starts at the first instant that does.
pub fn start_of_day(day: Date, zone: &TimeZone) -> Option<Timestamp> {
    let zoned: Zoned = day.to_zoned(zone.clone()).ok()?;
    zoned.start_of_day().ok().map(|start| start.timestamp())
}

pub fn add_days(day: Date, days: i32) -> Option<Date> {
    day.checked_add(days.days()).ok()
}
