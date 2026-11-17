//! Check-in analytics: sparse observations, independent sample counts, gaps
//! that are never zero, period changes, habit alignment, and workspace scope.

use super::analytics::{analytics, Analytics};
use super::{save, CheckinError};
use crate::habits::{create, set_completion};
use crate::test_support::{add_workspace, migrated_pool, DEFAULT_WORKSPACE, OTHER_WORKSPACE};
use sqlx::SqlitePool;

const WS: &str = DEFAULT_WORKSPACE;
const TODAY: &str = "2026-11-17";

async fn put(
    pool: &SqlitePool,
    workspace: &str,
    date: &str,
    ratings: [Option<i64>; 3],
    note: Option<&str>,
) {
    save(
        pool, workspace, date, ratings[0], ratings[1], ratings[2], note, TODAY,
    )
    .await
    .unwrap();
}

/// Five rated days, one note-only day, and gaps between.
async fn fill(pool: &SqlitePool) {
    put(pool, WS, "2026-11-02", [Some(4), Some(2), None], None).await;
    put(pool, WS, "2026-11-03", [Some(2), None, None], None).await;
    put(pool, WS, "2026-11-05", [None, Some(5), Some(3)], None).await;
    put(pool, WS, "2026-11-10", [None, None, Some(1)], None).await;
    put(
        pool,
        WS,
        "2026-11-11",
        [None, None, None],
        Some("only a note"),
    )
    .await;
    put(pool, WS, "2026-11-16", [Some(5), Some(4), Some(5)], None).await;
}

async fn november(pool: &SqlitePool, habits: bool) -> Analytics {
    analytics(pool, WS, "2026-11-01", "2026-11-30", habits, TODAY)
        .await
        .unwrap()
}

#[test]
fn each_average_uses_only_the_days_that_rated_that_metric() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        fill(&pool).await;
        let a = november(&pool, false).await;
        assert_eq!((a.days_recorded, a.days_in_period), (6, 17));
        assert_eq!(a.through, "2026-11-17");
        // Three days rated mood, three energy, three focus, from different days.
        assert_eq!(
            (a.mood.samples, a.energy.samples, a.focus.samples),
            (3, 3, 3)
        );
        assert_eq!(a.mood.average, Some(11.0 / 3.0));
        assert_eq!(a.energy.average, Some(11.0 / 3.0));
        assert_eq!(a.focus.average, Some(3.0));
        // Points are recorded days only, with unset ratings left unset.
        let dates: Vec<_> = a.points.iter().map(|p| p.date.as_str()).collect();
        assert_eq!(
            dates,
            [
                "2026-11-02",
                "2026-11-03",
                "2026-11-05",
                "2026-11-10",
                "2026-11-11",
                "2026-11-16"
            ]
        );
        assert_eq!(a.points[1].energy, None);
        assert_eq!(a.points[4].mood, None);
        assert_eq!(a.habits, None);
    });
}

#[test]
fn weeks_and_months_keep_gaps_as_none_and_report_sample_counts() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        fill(&pool).await;
        let a = november(&pool, false).await;
        let weeks: Vec<_> = a
            .weeks
            .iter()
            .map(|w| (w.start.as_str(), w.end.as_str()))
            .collect();
        assert_eq!(
            weeks,
            [
                ("2026-11-01", "2026-11-01"),
                ("2026-11-02", "2026-11-08"),
                ("2026-11-09", "2026-11-15"),
                ("2026-11-16", "2026-11-22"),
                ("2026-11-23", "2026-11-29"),
                ("2026-11-30", "2026-11-30"),
            ]
        );
        // Nov 2 to 8: mood 4 and 2, energy 2 and 5, focus 3 only.
        let w = &a.weeks[1];
        assert_eq!((w.mood.samples, w.mood.average), (2, Some(3.0)));
        assert_eq!((w.energy.samples, w.energy.average), (2, Some(3.5)));
        assert_eq!((w.focus.samples, w.focus.average), (1, Some(3.0)));
        // Nov 9 to 15 rated only focus; the note-only day adds no sample.
        let w = &a.weeks[2];
        assert_eq!((w.mood.samples, w.mood.average), (0, None));
        assert_eq!((w.energy.samples, w.energy.average), (0, None));
        assert_eq!((w.focus.samples, w.focus.average), (1, Some(1.0)));
        // Nothing rated in a week: no average at all, never 0.
        let w = &a.weeks[4];
        assert_eq!(
            (w.mood.average, w.energy.average, w.focus.average),
            (None, None, None)
        );
        // The month adds up over its weeks' samples.
        assert_eq!(a.months.len(), 1);
        assert_eq!(a.months[0].mood, a.mood);
        let sum =
            |pick: fn(&super::analytics::Period) -> i64| a.weeks.iter().map(pick).sum::<i64>();
        assert_eq!(sum(|w| w.mood.samples), a.mood.samples);
        assert_eq!(sum(|w| w.energy.samples), a.energy.samples);
        assert_eq!(sum(|w| w.focus.samples), a.focus.samples);
    });
}

#[test]
fn a_changed_period_changes_what_is_counted() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        fill(&pool).await;
        let a = analytics(&pool, WS, "2026-11-04", "2026-11-12", false, TODAY)
            .await
            .unwrap();
        assert_eq!(a.days_recorded, 3);
        assert_eq!((a.mood.samples, a.mood.average), (0, None));
        assert_eq!((a.energy.samples, a.energy.average), (1, Some(5.0)));
        assert_eq!((a.focus.samples, a.focus.average), (2, Some(2.0)));
        assert_eq!(a.days_in_period, 9);
        // A period wholly in the future has no days and no data.
        let future = analytics(&pool, WS, "2026-11-18", "2026-11-30", false, TODAY)
            .await
            .unwrap();
        assert_eq!((future.days_in_period, future.days_recorded), (0, 0));
        assert_eq!(future.mood.average, None);
        // An empty workspace has defined, empty output.
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let empty = analytics(
            &pool,
            OTHER_WORKSPACE,
            "2026-11-01",
            "2026-11-30",
            true,
            TODAY,
        )
        .await
        .unwrap();
        assert_eq!(
            (empty.days_recorded, empty.mood.samples, empty.mood.average),
            (0, 0, None)
        );
        assert!(empty.points.is_empty());
        assert_eq!(empty.habits.unwrap().percent, None);
        for (from, to, error) in [
            ("2026-11-30", "2026-11-01", CheckinError::InvalidRange),
            ("2000-01-01", "2026-11-01", CheckinError::InvalidRange),
            ("2026-02-30", "2026-03-01", CheckinError::InvalidDate),
        ] {
            assert_eq!(
                analytics(&pool, WS, from, to, false, TODAY).await,
                Err(error),
                "{from}..{to}"
            );
        }
    });
}

#[test]
fn habit_consistency_lines_up_with_the_same_weeks_and_months() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        fill(&pool).await;
        let walk = create(&pool, WS, "Walk", Some("2026-11-01"), TODAY)
            .await
            .unwrap();
        for day in ["2026-11-02", "2026-11-03", "2026-11-05"] {
            set_completion(&pool, WS, &walk.id, day, true, TODAY)
                .await
                .unwrap();
        }
        let with = november(&pool, true).await;
        let without = november(&pool, false).await;
        // The same boundaries, with or without the comparison.
        let bounds = |a: &Analytics| {
            a.weeks
                .iter()
                .map(|w| (w.start.clone(), w.end.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(bounds(&with), bounds(&without));
        assert!(without.weeks.iter().all(|w| w.habits.is_none()));
        // Nov 2 to 8: 7 eligible days, 3 completed.
        let counts = with.weeks[1].habits.unwrap();
        assert_eq!((counts.eligible, counts.completed), (7, 3));
        assert!((counts.percent.unwrap() - 300.0 / 7.0).abs() < 1e-9);
        // A week with no eligible day yet has no percentage, not zero.
        let future = with.weeks[4].habits.unwrap();
        assert_eq!((future.eligible, future.percent), (0, None));
        // Ratings are unchanged by asking for the comparison.
        assert_eq!(with.mood, without.mood);
        assert_eq!(with.habits.unwrap().completed, 3);
    });
}

#[test]
fn reads_are_scoped_to_the_workspace() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        fill(&pool).await;
        put(
            &pool,
            OTHER_WORKSPACE,
            "2026-11-04",
            [Some(1), Some(1), Some(1)],
            Some("theirs"),
        )
        .await;
        let mine = november(&pool, false).await;
        assert_eq!(mine.days_recorded, 6);
        assert!(mine.points.iter().all(|p| p.date != "2026-11-04"));
        let theirs = analytics(
            &pool,
            OTHER_WORKSPACE,
            "2026-11-01",
            "2026-11-30",
            false,
            TODAY,
        )
        .await
        .unwrap();
        assert_eq!((theirs.days_recorded, theirs.mood.average), (1, Some(1.0)));
    });
}
