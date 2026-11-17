//! Habit statistics: Ember's fixture F1, leap years and month lengths,
//! inclusive archive days, future days, zero denominators, and the separate
//! individual and practice streaks. Dates are synthetic.

use super::stats::{compute, statistics, streaks, HabitDays, HabitStatistics, Streaks};
use super::{archive, create, set_completion, HabitError};
use crate::test_support::{add_workspace, migrated_pool, DEFAULT_WORKSPACE, OTHER_WORKSPACE};
use jiff::civil::Date;
use std::collections::{BTreeSet, HashSet};

fn d(date: &str) -> Date {
    date.parse().unwrap()
}

fn days(dates: &[&str]) -> BTreeSet<Date> {
    dates.iter().map(|date| d(date)).collect()
}

fn habit(id: &str, start: &str, archived_on: Option<&str>, done: &[&str]) -> HabitDays {
    HabitDays {
        id: id.into(),
        name: id.to_uppercase(),
        start: d(start),
        archived_on: archived_on.map(d),
        completed: days(done),
    }
}

/// docs/HABITS.md F1, as Ember's synthetic fixture.
fn f1() -> Vec<HabitDays> {
    vec![
        habit("walk", "2028-01-01", None, &[]),
        habit("retired", "2027-12-01", Some("2028-01-15"), &["2028-01-10"]),
        habit("read", "2028-02-01", None, &["2028-02-28", "2028-02-29"]),
    ]
}

fn run(habits: &[HabitDays], from: &str, to: &str, today: &str) -> HabitStatistics {
    compute(habits, None, d(from), d(to), d(today))
}

fn counts(stats: &HabitStatistics, id: &str) -> (i64, i64) {
    let habit = stats.habits.iter().find(|h| h.habit_id == id).unwrap();
    (habit.counts.eligible, habit.counts.completed)
}

fn streak(dates: &[&str], today: &str) -> (i64, i64) {
    let found = streaks(&days(dates), d(today));
    (found.current, found.longest)
}

#[test]
fn fixture_f1_counts_and_rates_match_ember_rules() {
    let stats = run(&f1(), "2028-01-01", "2028-03-01", "2028-03-01");
    // Walk: Jan 1 to Mar 1 in a leap year, never done. Zero is a real answer.
    assert_eq!(counts(&stats, "walk"), (61, 0));
    assert_eq!(stats.habits[0].counts.percent, Some(0.0));
    // Retired: Jan 1 to its archive day Jan 15 inclusive.
    assert_eq!(counts(&stats, "retired"), (15, 1));
    assert!((stats.habits[1].counts.percent.unwrap() - 100.0 / 15.0).abs() < 1e-9);
    assert!(stats.habits[1].archived && !stats.habits[0].archived);
    // Read starts Feb 1: 29 February days plus Mar 1.
    assert_eq!(counts(&stats, "read"), (30, 2));
    assert_eq!((stats.summary.eligible, stats.summary.completed), (106, 3));
    assert!((stats.summary.percent.unwrap() - 300.0 / 106.0).abs() < 1e-9);
    assert_eq!(stats.through, "2028-03-01");

    // Months are calendar months, so leap February has 29 days.
    let months: Vec<_> = stats
        .months
        .iter()
        .map(|m| {
            (
                m.start.as_str(),
                m.end.as_str(),
                m.counts.eligible,
                m.counts.completed,
            )
        })
        .collect();
    assert_eq!(
        months,
        [
            ("2028-01-01", "2028-01-31", 46, 1),
            ("2028-02-01", "2028-02-29", 58, 2),
            ("2028-03-01", "2028-03-01", 2, 0),
        ]
    );
}

#[test]
fn weeks_and_months_tile_the_period_and_add_up() {
    let habits = f1();
    // A period that starts mid-week and mid-month and runs past today.
    let stats = run(&habits, "2027-12-15", "2028-06-30", "2028-03-01");
    for buckets in [&stats.weeks, &stats.months] {
        assert_eq!(buckets.first().unwrap().start, "2027-12-15");
        assert_eq!(buckets.last().unwrap().end, "2028-06-30");
        for pair in buckets.windows(2) {
            let next_day = d(&pair[0].end).tomorrow().unwrap();
            assert_eq!(pair[1].start, next_day.to_string());
        }
        let eligible: i64 = buckets.iter().map(|b| b.counts.eligible).sum();
        let completed: i64 = buckets.iter().map(|b| b.counts.completed).sum();
        assert_eq!(
            (eligible, completed),
            (stats.summary.eligible, stats.summary.completed)
        );
    }
    // Weeks run Monday to Sunday, except where the period clips them.
    for week in &stats.weeks[1..stats.weeks.len() - 1] {
        assert_eq!(d(&week.start).weekday().to_monday_one_offset(), 1);
        assert_eq!(d(&week.end).weekday().to_monday_one_offset(), 7);
    }
    // 2027-12-15 is a Wednesday, so the first week ends Sunday the 19th.
    assert_eq!(stats.weeks[0].end, "2027-12-19");
    // Future weeks stay listed, with no eligible days and no percentage.
    let last = stats.weeks.last().unwrap();
    assert_eq!((last.counts.eligible, last.counts.percent), (0, None));
}

#[test]
fn future_days_never_count_and_the_archive_day_is_inclusive() {
    let habits = vec![
        habit("a", "2026-11-10", None, &["2026-11-16", "2026-11-17"]),
        habit("b", "2026-11-01", Some("2026-11-12"), &["2026-11-12"]),
    ];
    let today = run(&habits, "2026-11-01", "2026-11-17", "2026-11-17");
    let later = run(&habits, "2026-11-01", "2026-12-31", "2026-11-17");
    assert_eq!(today.summary, later.summary);
    assert_eq!(later.through, "2026-11-17");
    // a: Nov 10 to 17 is 8 days. b: Nov 1 to 12 inclusive is 12.
    assert_eq!(counts(&later, "a"), (8, 2));
    assert_eq!(counts(&later, "b"), (12, 1));
    // The day after the archive day is not eligible.
    let after = run(&habits, "2026-11-13", "2026-11-17", "2026-11-17");
    assert_eq!(counts(&after, "b"), (0, 0));
    assert_eq!(after.habits[1].counts.percent, None);
    // A period wholly in the future has nothing eligible.
    let future = run(&habits, "2026-11-18", "2026-12-18", "2026-11-17");
    assert_eq!((future.summary.eligible, future.summary.percent), (0, None));
}

#[test]
fn empty_history_and_zero_eligible_days_have_defined_outputs() {
    let none = run(&[], "2026-11-01", "2026-11-30", "2026-11-17");
    assert_eq!((none.summary.eligible, none.summary.completed), (0, 0));
    assert_eq!(none.summary.percent, None);
    assert!(none.habits.is_empty());
    assert_eq!(
        none.practice,
        Streaks {
            current: 0,
            longest: 0
        }
    );
    // Buckets still tile the period.
    assert_eq!(none.months.len(), 1);
    assert!(none.weeks.iter().all(|w| w.counts.percent.is_none()));

    // A habit that has not started yet in the period.
    let habits = vec![habit("new", "2026-12-01", None, &[])];
    let stats = run(&habits, "2026-11-01", "2026-11-30", "2026-11-17");
    assert_eq!(counts(&stats, "new"), (0, 0));
    assert_eq!(stats.habits[0].counts.percent, None);

    // A habit that starts today has one eligible day.
    let today = vec![habit("t", "2026-11-17", None, &[])];
    let stats = run(&today, "2026-11-01", "2026-11-30", "2026-11-17");
    assert_eq!(stats.habits[0].counts.percent, Some(0.0));
    assert_eq!(
        stats.habits[0].streaks,
        Streaks {
            current: 0,
            longest: 0
        }
    );
    let done = vec![habit("t", "2026-11-17", None, &["2026-11-17"])];
    let stats = run(&done, "2026-11-01", "2026-11-30", "2026-11-17");
    assert_eq!(stats.habits[0].counts.percent, Some(100.0));
    assert_eq!(
        stats.habits[0].streaks,
        Streaks {
            current: 1,
            longest: 1
        }
    );
}

#[test]
fn streaks_follow_ember_across_months_leap_days_and_years() {
    assert_eq!(streak(&[], "2026-11-17"), (0, 0));
    // Today is still open: a run ending yesterday is current.
    assert_eq!(streak(&["2026-11-15", "2026-11-16"], "2026-11-17"), (2, 2));
    // Done today as well.
    assert_eq!(
        streak(&["2026-11-15", "2026-11-16", "2026-11-17"], "2026-11-17"),
        (3, 3)
    );
    // Two days without a completion ends it; the longest stays.
    assert_eq!(streak(&["2026-11-14", "2026-11-15"], "2026-11-17"), (0, 2));
    // The longest run need not be the current one.
    assert_eq!(
        streak(
            &[
                "2026-11-01",
                "2026-11-02",
                "2026-11-03",
                "2026-11-09",
                "2026-11-10"
            ],
            "2026-11-10"
        ),
        (2, 3)
    );
    // Feb 28 to Mar 1 is consecutive in 2027 but skips Feb 29 in 2028.
    assert_eq!(streak(&["2027-02-28", "2027-03-01"], "2027-03-01"), (2, 2));
    assert_eq!(streak(&["2028-02-28", "2028-03-01"], "2028-03-01"), (1, 1));
    assert_eq!(
        streak(&["2028-02-28", "2028-02-29", "2028-03-01"], "2028-03-01"),
        (3, 3)
    );
    // Across a year boundary.
    assert_eq!(streak(&["2026-12-31", "2027-01-01"], "2027-01-01"), (2, 2));
    // A date after today is ignored.
    assert_eq!(streak(&["2026-11-17", "2026-11-18"], "2026-11-17"), (1, 1));
}

#[test]
fn individual_and_practice_streaks_are_separate_measures() {
    // Two habits that alternate days: neither has a streak above 1, but every
    // day has some completion, so the practice streak is unbroken.
    let habits = vec![
        habit(
            "odd",
            "2026-11-01",
            None,
            &["2026-11-11", "2026-11-13", "2026-11-15"],
        ),
        habit(
            "even",
            "2026-11-01",
            Some("2026-11-16"),
            &["2026-11-12", "2026-11-14", "2026-11-16"],
        ),
    ];
    let stats = run(&habits, "2026-11-01", "2026-11-17", "2026-11-17");
    assert_eq!(
        stats.habits[0].streaks,
        Streaks {
            current: 0,
            longest: 1
        }
    );
    assert_eq!(
        stats.habits[1].streaks,
        // Done yesterday (the 16th) and today is still open, so it is current.
        Streaks {
            current: 1,
            longest: 1
        }
    );
    // Archived history still counts: 11th to 16th is six days, ending yesterday.
    assert_eq!(
        stats.practice,
        Streaks {
            current: 6,
            longest: 6
        }
    );

    // Selecting one habit changes the table and totals, not the practice streak.
    let only: HashSet<String> = ["odd".to_string()].into();
    let picked = compute(
        &habits,
        Some(&only),
        d("2026-11-01"),
        d("2026-11-17"),
        d("2026-11-17"),
    );
    assert_eq!(picked.habits.len(), 1);
    assert_eq!(picked.summary.eligible, 17);
    assert_eq!(picked.practice, stats.practice);
}

#[test]
fn the_database_path_loads_history_and_validates_the_period() {
    tauri::async_runtime::block_on(async {
        let pool = migrated_pool().await;
        let ws = DEFAULT_WORKSPACE;
        let today = "2026-11-17";
        let walk = create(&pool, ws, "Walk", Some("2026-11-10"), today)
            .await
            .unwrap();
        let read = create(&pool, ws, "Read", Some("2026-11-01"), today)
            .await
            .unwrap();
        for date in ["2026-11-15", "2026-11-16", "2026-11-17"] {
            set_completion(&pool, ws, &walk.id, date, true, today)
                .await
                .unwrap();
        }
        set_completion(&pool, ws, &read.id, "2026-11-05", true, today)
            .await
            .unwrap();
        archive(&pool, ws, &read.id, "2026-11-06").await.unwrap();

        let stats = statistics(&pool, ws, "2026-11-01", "2026-11-30", None, today)
            .await
            .unwrap();
        // Saved order, with archived habits included.
        let names: Vec<_> = stats.habits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["Walk", "Read"]);
        assert_eq!(counts(&stats, &walk.id), (8, 3));
        // Archived on Nov 6, so Nov 1 to 6 are its six eligible days.
        assert_eq!(counts(&stats, &read.id), (6, 1));
        assert_eq!(
            stats.habits[0].streaks,
            Streaks {
                current: 3,
                longest: 3
            }
        );
        assert_eq!(
            stats.practice,
            Streaks {
                current: 3,
                longest: 3
            }
        );

        // Another workspace sees none of it.
        add_workspace(&pool, OTHER_WORKSPACE, "Other").await;
        let other = statistics(
            &pool,
            OTHER_WORKSPACE,
            "2026-11-01",
            "2026-11-30",
            None,
            today,
        )
        .await
        .unwrap();
        assert!(other.habits.is_empty());
        assert_eq!(
            other.practice,
            Streaks {
                current: 0,
                longest: 0
            }
        );

        let picked = statistics(
            &pool,
            ws,
            "2026-11-01",
            "2026-11-30",
            Some(&[walk.id.clone()]),
            today,
        )
        .await
        .unwrap();
        assert_eq!(picked.habits.len(), 1);
        assert_eq!(
            statistics(
                &pool,
                ws,
                "2026-11-01",
                "2026-11-30",
                Some(&["nope".into()]),
                today
            )
            .await,
            Err(HabitError::NotFound)
        );

        for (from, to, error) in [
            ("2026-11-30", "2026-11-01", HabitError::InvalidRange),
            ("1900-01-01", "2026-01-01", HabitError::InvalidRange),
            ("2026-02-30", "2026-03-01", HabitError::InvalidDate),
            ("2026-11-01", "tomorrow", HabitError::InvalidDate),
        ] {
            assert_eq!(
                statistics(&pool, ws, from, to, None, today).await,
                Err(error),
                "{from} to {to}"
            );
        }
        // One day is a valid period.
        assert!(statistics(&pool, ws, today, today, None, today)
            .await
            .is_ok());
    });
}
