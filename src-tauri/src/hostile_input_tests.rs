//! Ordinary invalid input must produce an error or a clean save, never a
//! panic or a damaged database (U2-P6-15). Every create and update path that
//! takes free text, a date, or a time zone gets the same hostile values.

use crate::issues::{self, IssueFields};
use crate::milestones::{self, MilestoneInput};
use crate::scheduling::{create_event, EventInput};
use crate::test_support::{migrated_pool, DEFAULT_WORKSPACE};
use crate::{checkins, dashboards, documents, habits};
use serde_json::json;

const WS: &str = DEFAULT_WORKSPACE;

fn hostile() -> Vec<String> {
    let mut values: Vec<String> = [
        "",
        " ",
        "\0",
        "a\0b",
        "\u{202e}rtl override",
        "\u{feff}bom",
        "😀🎉 emoji",
        "２０２６-０１-０１",
        "2026-02-30",
        "2026-13-01",
        "9999-99-99",
        "0000-00-00",
        "-1",
        "NaN",
        "1e999",
        "'; DROP TABLE issues; --",
        "../../etc/passwd",
        "<script>alert(1)</script>",
        "Not/AZone",
        "2026-11-17T25:61",
        "{\"type\":\"doc\"",
        "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[",
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    values.push("x".repeat(100_000));
    values.push("é".repeat(50_000));
    values
}

#[test]
fn hostile_text_dates_and_zones_never_panic_or_damage_the_database() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let (mut saved, mut refused) = (0, 0);
        let mut count = |ok: bool| if ok { saved += 1 } else { refused += 1 };
        for value in hostile() {
            count(
                issues::create(
                    &pool,
                    WS,
                    IssueFields {
                        title: value.clone(),
                        description: Some(value.clone()),
                        priority: Some(value.clone()),
                        start_date: Some(value.clone()),
                        due_date: Some(value.clone()),
                    },
                    None,
                )
                .await
                .is_ok(),
            );
            count(
                milestones::create(
                    &pool,
                    WS,
                    MilestoneInput {
                        title: value.clone(),
                        description: Some(value.clone()),
                        due_date: Some(value.clone()),
                    },
                    None,
                )
                .await
                .is_ok(),
            );
            if let Ok(document) = documents::create(&pool, WS, Some(&value)).await {
                count(true);
                count(
                    documents::update(&pool, WS, &document.id, &value, &value)
                        .await
                        .is_ok(),
                );
            } else {
                count(false);
            }
            count(
                habits::create(&pool, WS, &value, Some(&value), &value)
                    .await
                    .is_ok(),
            );
            count(
                checkins::save(
                    &pool,
                    WS,
                    &value,
                    Some(9),
                    Some(0),
                    None,
                    Some(&value),
                    &value,
                )
                .await
                .is_ok(),
            );
            count(
                create_event(
                    &pool,
                    WS,
                    EventInput {
                        title: value.clone(),
                        description: value.clone(),
                        location: Some(value.clone()),
                        url: Some(value.clone()),
                        time_zone: Some(value.clone()),
                        start: Some(value.clone()),
                        end: Some(value.clone()),
                        start_date: Some(value.clone()),
                        end_date: Some(value.clone()),
                        ..Default::default()
                    },
                )
                .await
                .is_ok(),
            );
            count(
                dashboards::save(
                    &pool,
                    WS,
                    None,
                    &value,
                    json!({"version": 1, "widgets": value}),
                )
                .await
                .is_ok(),
            );
        }
        assert!(
            refused > saved,
            "most hostile input must be refused ({refused} refused, {saved} saved)"
        );

        // Whatever was saved left the database consistent.
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
        let broken = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(broken.is_empty());
        // The table the injection attempt names still exists and still accepts
        // ordinary input after all of the above.
        issues::create(
            &pool,
            WS,
            IssueFields {
                title: "An ordinary issue".into(),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        let issues: i64 = sqlx::query_scalar("SELECT count(*) FROM issues")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(issues >= 1);
    });
}
