use super::*;
use crate::scheduling::recurrence::{cancel_occurrence, update_occurrence};
use crate::scheduling::{create_event, EventInput};
use crate::test_support::{migrated_pool, DEFAULT_WORKSPACE};

const WS: &str = DEFAULT_WORKSPACE;

async fn run(pool: &SqlitePool, text: &str, commit: bool) -> IcsReport {
    import(pool, WS, text, None, "Europe/Paris", commit)
        .await
        .unwrap()
}

async fn count(pool: &SqlitePool, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
        .fetch_one(pool)
        .await
        .unwrap()
}

fn calendar(body: &str) -> String {
    format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n{body}END:VCALENDAR\r\n")
}

async fn events(pool: &SqlitePool) -> Vec<Event> {
    sqlx::query_as(&format!(
        "SELECT {EVENT_FIELDS} FROM events ORDER BY title, id"
    ))
    .fetch_all(pool)
    .await
    .unwrap()
}

/// Two events compared by what the file carries, not by their IDs.
fn same(a: &Event, b: &Event) -> bool {
    let key = |e: &Event| {
        format!(
            "{:?}",
            (
                (&e.title, &e.description, &e.location, &e.url, e.all_day),
                (&e.start_date, &e.end_date, &e.time_zone),
                (&e.start_local, &e.end_local, &e.start_at, &e.end_at),
                (
                    &e.repeat_freq,
                    e.repeat_interval,
                    e.repeat_count,
                    &e.repeat_until
                ),
            )
        )
    };
    key(a) == key(b)
}

#[test]
fn reads_folded_lines_escapes_and_every_date_form() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let file = calendar(concat!(
            "BEGIN:VEVENT\r\nUID:a@test\r\nDTSTAMP:20261101T000000Z\r\n",
            "DTSTART;TZID=America/New_York:20261118T090000\r\n",
            "DTEND;TZID=America/New_York:20261118T103000\r\n",
            "SUMMARY:Planning\\, part 1: a very long title that has to be folded across seve\r\n",
            " ral lines because it is longer than seventy-five octets\r\n",
            "DESCRIPTION:Line one\\nLine two\\; with a semicolon\\\\ and a backslash\r\n",
            "LOCATION:Room 4\r\nURL:https://example.com/a\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:b@test\r\nDTSTART:20261118T140000Z\r\nDURATION:PT1H30M\r\nSUMMARY:UTC call\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:c@test\r\nDTSTART:20261118T080000\r\nDTEND:20261118T090000\r\nSUMMARY:Floating\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:d@test\r\nDTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261123\r\nSUMMARY:Trip\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:e@test\r\nDTSTART;VALUE=DATE:20261125\r\nSUMMARY:One day\r\nEND:VEVENT\r\n",
        ));
        let report = run(&pool, &file, true).await;
        assert_eq!(report.fatal, None);
        assert_eq!(report.imported.len(), 5, "{report:?}");
        assert!(report.applied);
        let stored = events(&pool).await;
        let by = |title: &str| stored.iter().find(|e| e.title.starts_with(title)).unwrap();

        let planning = by("Planning");
        assert_eq!(
            planning.title,
            "Planning, part 1: a very long title that has to be folded across several lines because it is longer than seventy-five octets"
        );
        assert_eq!(
            planning.description,
            "Line one\nLine two; with a semicolon\\ and a backslash"
        );
        assert_eq!(planning.time_zone.as_deref(), Some("America/New_York"));
        assert_eq!(planning.start_local.as_deref(), Some("2026-11-18T09:00"));
        assert_eq!(planning.start_at.as_deref(), Some("2026-11-18T14:00:00Z"));
        assert_eq!(planning.end_local.as_deref(), Some("2026-11-18T10:30"));
        assert_eq!(planning.location.as_deref(), Some("Room 4"));

        let utc = by("UTC call");
        assert_eq!(utc.time_zone.as_deref(), Some("UTC"));
        assert_eq!(utc.end_local.as_deref(), Some("2026-11-18T15:30"));
        // A floating time takes the zone the caller names.
        let floating = by("Floating");
        assert_eq!(floating.time_zone.as_deref(), Some("Europe/Paris"));
        assert_eq!(floating.start_at.as_deref(), Some("2026-11-18T07:00:00Z"));
        // An all-day end is exclusive in the file and in storage.
        let trip = by("Trip");
        assert!(trip.all_day);
        assert_eq!(
            (trip.start_date.as_deref(), trip.end_date.as_deref()),
            (Some("2026-11-20"), Some("2026-11-23"))
        );
        assert_eq!(by("One day").end_date.as_deref(), Some("2026-11-26"));
    });
}

#[test]
fn reads_recurrence_exceptions_and_overrides_and_explains_what_it_cannot() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let file = calendar(concat!(
            "BEGIN:VEVENT\r\nUID:s@test\r\nDTSTART;TZID=Europe/Paris:20261116T090000\r\nDTEND;TZID=Europe/Paris:20261116T093000\r\n",
            "RRULE:FREQ=DAILY;COUNT=5\r\nEXDATE;TZID=Europe/Paris:20261117T090000\r\nSUMMARY:Standup\r\n",
            "ATTENDEE:mailto:a@example.com\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:s@test\r\nRECURRENCE-ID;TZID=Europe/Paris:20261118T090000\r\n",
            "DTSTART;TZID=Europe/Paris:20261118T100000\r\nDTEND;TZID=Europe/Paris:20261118T103000\r\nSUMMARY:Standup (moved)\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:w@test\r\nDTSTART;VALUE=DATE:20261116\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\nSUMMARY:Gym\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:z@test\r\nDTSTART;TZID=Mars/Olympus:20261116T090000\r\nDTEND;TZID=Mars/Olympus:20261116T100000\r\nSUMMARY:Rover\r\nEND:VEVENT\r\n",
            "BEGIN:VTODO\r\nUID:t@test\r\nSUMMARY:Task\r\nEND:VTODO\r\n",
        ));
        let report = run(&pool, &file, true).await;
        assert_eq!(report.imported.len(), 1, "{report:?}");
        assert_eq!(report.imported[0].exceptions, 2);
        let reasons: Vec<&str> = report.skipped.iter().map(|s| s.message.as_str()).collect();
        assert!(reasons.iter().any(|m| m.contains("BYDAY")), "{reasons:?}");
        assert!(
            reasons.iter().any(|m| m.contains("Mars/Olympus")),
            "{reasons:?}"
        );
        let warnings = report.warnings.join("\n");
        assert!(warnings.contains("ATTENDEE"), "{warnings}");
        assert!(warnings.contains("VALARM"), "{warnings}");
        assert!(warnings.contains("VTODO"), "{warnings}");
        // Nothing was stored for the skipped events.
        assert_eq!(count(&pool, "events").await, 1);
        assert_eq!(count(&pool, "event_exceptions").await, 2);
        let canceled: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM event_exceptions WHERE canceled = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(canceled, 1);
    });
}

#[test]
fn importing_twice_adds_nothing_and_a_preview_changes_nothing() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let file = calendar(
            "BEGIN:VEVENT\r\nUID:once@test\r\nDTSTART;VALUE=DATE:20261118\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\n",
        );
        let preview = run(&pool, &file, false).await;
        assert_eq!(preview.imported.len(), 1);
        assert!(!preview.applied);
        assert_eq!(count(&pool, "events").await, 0, "a preview writes nothing");

        let first = run(&pool, &file, true).await;
        assert_eq!(first.imported.len(), 1);
        let again = run(&pool, &file, true).await;
        assert!(again.imported.is_empty());
        assert_eq!(again.duplicates.len(), 1);
        assert_eq!(count(&pool, "events").await, 1);

        // An existing event is left as it is, even if the file differs.
        sqlx::query("UPDATE events SET title = 'Edited here'")
            .execute(&pool)
            .await
            .unwrap();
        run(&pool, &file, true).await;
        assert_eq!(events(&pool).await[0].title, "Edited here");
    });
}

#[test]
fn a_supported_file_round_trips_without_changing_events_recurrence_or_dates() {
    tauri::async_runtime::block_on(async {
        let source = migrated_pool().await;
        let timed = |title: &str, zone: &str, start: &str, end: &str| EventInput {
            title: title.into(),
            time_zone: Some(zone.into()),
            start: Some(start.into()),
            end: Some(end.into()),
            ..Default::default()
        };
        let mut meeting = timed(
            "Review; \"quarterly\", ok",
            "Europe/Paris",
            "2026-03-27T09:00",
            "2026-03-27T10:00",
        );
        meeting.description = "Agenda:\n1. Numbers\n2. Plan, with commas; and \\ slashes".into();
        meeting.location = Some("Room 4, Floor 2".into());
        meeting.url = Some("https://example.com/review?a=1&b=2".into());
        create_event(&source, WS, meeting).await.unwrap();
        // A repeating event across the Paris spring-forward night.
        let mut series = timed(
            "Standup",
            "Europe/Paris",
            "2026-03-27T09:00",
            "2026-03-27T09:15",
        );
        series.repeat = Some(RepeatRule {
            freq: "daily".into(),
            interval: 1,
            count: None,
            until: Some("2026-04-03".into()),
        });
        let series = create_event(&source, WS, series).await.unwrap();
        cancel_occurrence(&source, WS, &series.id, "2026-03-29T09:00")
            .await
            .unwrap();
        let mut changed = timed(
            "Standup (long)",
            "Europe/Paris",
            "2026-03-30T09:00",
            "2026-03-30T09:45",
        );
        changed.description = String::new();
        update_occurrence(&source, WS, &series.id, "2026-03-30T09:00", changed)
            .await
            .unwrap();
        // Multi-day all-day, repeating monthly.
        let mut trip = EventInput {
            title: "Retreat".into(),
            all_day: true,
            start_date: Some("2026-03-30".into()),
            end_date: Some("2026-04-02".into()),
            ..Default::default()
        };
        trip.repeat = Some(RepeatRule {
            freq: "monthly".into(),
            interval: 2,
            count: Some(3),
            until: None,
        });
        create_event(&source, WS, trip).await.unwrap();
        create_event(
            &source,
            WS,
            timed(
                "Zoned",
                "Asia/Tokyo",
                "2026-12-01T23:30",
                "2026-12-02T00:30",
            ),
        )
        .await
        .unwrap();

        let (file, written) = export(&source, WS).await.unwrap();
        assert_eq!(written, 4);
        assert!(file.starts_with("BEGIN:VCALENDAR\r\n") && file.ends_with("END:VCALENDAR\r\n"));
        assert!(
            file.lines().all(|line| line.len() <= 75),
            "lines are folded at 75 octets"
        );

        let target = migrated_pool().await;
        let report = run(&target, &file, true).await;
        assert_eq!(report.imported.len(), 4, "{report:?}");
        assert!(
            report.skipped.is_empty() && report.warnings.is_empty(),
            "{report:?}"
        );

        let (a, b) = (events(&source).await, events(&target).await);
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert!(same(x, y), "{x:?}\n{y:?}");
        }
        let exceptions = |pool: &SqlitePool| {
            let pool = pool.clone();
            async move {
                sqlx::query_as::<_, (String, bool, Option<String>, Option<String>, Option<String>, Option<String>)>(
                    "SELECT occurrence, canceled, title, start_local, end_local, start_at FROM event_exceptions ORDER BY occurrence",
                )
                .fetch_all(&pool)
                .await
                .unwrap()
            }
        };
        assert_eq!(exceptions(&source).await, exceptions(&target).await);
        // Exporting what was imported gives the same file, apart from stamps.
        let strip = |text: &str| {
            text.lines()
                .filter(|l| !l.starts_with("DTSTAMP"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(strip(&export(&target, WS).await.unwrap().0), strip(&file));
        // And importing the app's own export again finds every event.
        let again = run(&source, &file, true).await;
        assert_eq!(again.duplicates.len(), 4);
        assert_eq!(count(&source, "events").await, 4);
    });
}

#[test]
fn invalid_input_reports_a_reason_and_leaves_the_calendar_alone() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        for (text, needle) in [
            ("hello", "BEGIN:VCALENDAR"),
            (
                "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n",
                "do not match",
            ),
            ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n", "ends before"),
        ] {
            let report = run(&pool, text, true).await;
            assert!(
                report.fatal.as_deref().is_some_and(|m| m.contains(needle)),
                "{text:?} {report:?}"
            );
            assert!(!report.applied);
        }
        let big = format!(
            "BEGIN:VCALENDAR\r\nX-PAD:{}\r\nEND:VCALENDAR\r\n",
            "x".repeat(MAX_BYTES)
        );
        assert!(run(&pool, &big, true)
            .await
            .fatal
            .unwrap()
            .contains("5 MiB"));
        let many: String = (0..=MAX_EVENTS)
            .map(|i| format!("BEGIN:VEVENT\r\nUID:{i}\r\nSUMMARY:x\r\nDTSTART;VALUE=DATE:20261118\r\nEND:VEVENT\r\n"))
            .collect();
        assert!(run(&pool, &calendar(&many), true)
            .await
            .fatal
            .unwrap()
            .contains("more than"));

        // One bad event is skipped whole while a good one imports.
        let file = calendar(concat!(
            "BEGIN:VEVENT\r\nUID:bad1\r\nDTSTART;VALUE=DATE:20261118\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:bad2\r\nSUMMARY:Backwards\r\nDTSTART:20261118T100000Z\r\nDTEND:20261118T090000Z\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:bad3\r\nSUMMARY:No end\r\nDTSTART:20261118T100000Z\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:bad4\r\nSUMMARY:Huge repeat\r\nDTSTART;VALUE=DATE:20261118\r\nRRULE:FREQ=DAILY;COUNT=5000\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:bad5\r\nSUMMARY:Both limits\r\nDTSTART;VALUE=DATE:20261118\r\nRRULE:FREQ=DAILY;COUNT=2;UNTIL=20261201\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:bad6\r\nSUMMARY:Orphan\r\nRECURRENCE-ID;VALUE=DATE:20261118\r\nDTSTART;VALUE=DATE:20261118\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:good\r\nSUMMARY:Fine\r\nDTSTART;VALUE=DATE:20261118\r\nEND:VEVENT\r\n",
        ));
        let report = run(&pool, &file, true).await;
        assert_eq!(report.imported.len(), 1, "{report:?}");
        assert_eq!(report.skipped.len(), 6, "{report:?}");
        assert!(report.skipped.iter().all(|issue| !issue.message.is_empty()));
        assert_eq!(count(&pool, "events").await, 1);
        let unknown_calendar = import(&pool, WS, &file, Some("nope".into()), "UTC", true)
            .await
            .unwrap();
        assert!(unknown_calendar.imported.is_empty());
        assert_eq!(count(&pool, "events").await, 1);
        assert!(matches!(
            import(&pool, WS, &file, None, "Not/AZone", true).await,
            Err(SchedulingError::InvalidTimeZone)
        ));
    });
}

#[test]
fn folding_never_splits_a_character_and_text_escapes_round_trip() {
    let mut out = String::new();
    let long = format!("SUMMARY:{}", "é".repeat(100));
    fold(&long, &mut out);
    for line in out.split("\r\n").filter(|l| !l.is_empty()) {
        assert!(line.len() <= 75, "{line:?}");
    }
    assert_eq!(unfold(&out).concat(), long);
    let text = "a\\b;c,d\ne";
    assert_eq!(unescape(&escape(text)), text);
    assert_eq!(
        parse_line("DTSTART;TZID=\"A:B\";VALUE=X:2026")
            .unwrap()
            .param("TZID"),
        Some("A:B")
    );
}
