# Habits and the Ember port

Phase 4 brings Ember's monthly habit tracker into Unhollowed. This document is the contract for that port: what was audited, which Ember rules are kept, where Unhollowed deliberately differs, and how habit data is stored, changed, and later imported. Issues U2-P4-02 to U2-P4-08 implement it.

## Sources audited

- **Ember** at revision [`2351a23`](https://github.com/arlecchinoOPSource/Ember-by-Arlecchino/tree/2351a239775a7e33543cb76d16846c228a583eaf) (`desktop/`, `docs/DATA.md`, `docs/ARCHITECTURE.md`).
- **Unhollowed** at the end of Phase 3: [data model](DATA_MODEL.md), `src-tauri/src/database.rs`, the label, issue, and scheduling modules, and `src/database`.

**Licensing.** Ember is MIT licensed, copyright 2026 Arlecchino, the same owner as this repository. Direct reuse is allowed. Files that copy substantial Ember code keep a one-line notice naming the source file and the MIT license. Ember's sounds, fonts, and `@arlecchino/suite-ui` terminal chrome are not reused.

## Ember module map

| Ember file                    | What it does                                                                                                | Use in Unhollowed                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/calendar.ts`             | Pure date rules: month dates, leap years, eligibility, visible columns, cell state, keyboard moves, streaks | **Port** the pure functions with tests. Change `cellState` for pre-start days (see Parity differences)                             |
| `src/HabitGrid.tsx`           | ARIA grid: dates as rows, habits as columns, one Tab stop, arrow/Home/End/Page keys, `aria-disabled` cells  | **Port** the interaction contract. Restyle with Unhollowed tokens and shell                                                        |
| `src/App.tsx`                 | Month state, Today, month and year navigation, load and save status, midnight rollover                      | **Adapt** navigation, Today, save status, and rollover into a `src/features/habits` page. Drop sound, startup, and terminal chrome |
| `src/Panels.tsx`              | Archive month list, habit manager (rename, move, archive, delete with preview), summary                     | **Adapt** later: the manager in U2-P4-05, the summary in U2-P4-08 and U2-P4-09                                                     |
| `src/native.ts`               | Typed IPC wrappers, each resolving after SQLite commits                                                     | **Pattern only.** Unhollowed uses `src/database/habits.ts` with structured error codes                                             |
| `src-tauri/src/storage.rs`    | rusqlite schema v1, validation, create, rename, move, archive, delete preview, month rows, toggle           | **Rewrite** in sqlx with workspace scope and UUIDs. Keep the name and date validation                                              |
| `src-tauri/src/backup.rs`     | `ember-backup` v1 JSON: write, validate, restore with a pre-restore copy; CSV and JSON export               | **Read** its format in U2-P4-06. Unhollowed's own backup and export are U2-P4-07                                                   |
| `src-tauri/src/import.rs`     | Website `daily-bitmask-v1` snapshot import                                                                  | **Not ported.** See Import sources                                                                                                 |
| `src-tauri/src/commands.rs`   | One serialized connection; `today()` from the local clock                                                   | **Pattern only.** Rust resolves today and the active workspace                                                                     |
| `standalone.rs`, sound, prefs | Standalone app, sound, startup, preferences                                                                 | **Not reused**                                                                                                                     |

## Schemas compared

| Concept      | Ember SQLite v1 (`user_version` 1)                      | Ember JSON backup v1                   | Unhollowed (migration 0026)                                                                           |
| ------------ | ------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Owner        | Whole file                                              | Whole file                             | `workspace_id`, required, with same-workspace triggers                                                |
| Habit ID     | `id`, 32 lowercase hex, `lower(hex(randomblob(16)))`    | `habits[].id`, same                    | `id`, UUID v4 from Rust. An Ember ID is kept as `source_id`                                           |
| Name         | 1–60 visible characters, unique among active habits     | `habits[].name`                        | Same rule. `name_key` (lowercase) is unique among active habits in the workspace                      |
| Order        | `sort_order`, unique over all habits, archived included | `habits[].sortOrder`                   | `position`, unique per workspace, archived included                                                   |
| Start        | `start_date`, local `YYYY-MM-DD`                        | `habits[].startDate`                   | `start_date`, same                                                                                    |
| Archive      | `archived_at`, local date, the **last eligible day**    | `habits[].archivedAt`                  | `archived_on`, same meaning. Renamed because `archived_at` is a UTC timestamp elsewhere in Unhollowed |
| Completion   | Row in `completions (habit_id, date)`; absence is false | `completions: [[habitId, date], …]`    | Row in `habit_completions (habit_id, date)` with `workspace_id`                                       |
| Change guard | Delete preview token: the JSON list of completion dates | —                                      | `habits.revision`, raised by every write to the habit or its completions                              |
| Provenance   | —                                                       | `format: "ember-backup"`, `version: 1` | `source` (`ember`) and `source_id`, both null for habits made here                                    |

Dates are local calendar days compared as text, as in Ember. No time zone is stored or applied: a habit-day is the same day wherever the device is.

## Rules kept from Ember

- **Eligibility.** A habit is eligible from `start_date` through `archived_on`, inclusive. A completion on the archive day stays visible and editable. Archiving never sets `archived_on` earlier than `start_date`.
- **Binary completion.** A row means done, no row means not done. Archiving never deletes rows.
- **Future days** are never editable. Today comes from the device clock in Rust and rolls over at local midnight in the UI.
- **Columns** follow the saved order. An archived habit is a column only in months where it was eligible on at least one day, so history stays visible.
- **Grid keyboard contract.** One Tab stop. Arrows move one cell, Home and End go to the row's ends, Ctrl/⌘+Home and End to the grid's corners, Page Up and Down move seven days. Space or Enter toggles. Unavailable cells stay focusable with `aria-disabled` and a stated reason, so moving never skips a date.
- **Deletion** is only for archived habits and needs a preview of what will be lost. A preview that no longer matches must be reviewed again.
- **Practice streaks** (U2-P4-08) count consecutive local days with at least one eligible completion across all habits, archived history included. Current ends today or yesterday.

## Parity differences

These are deliberate. Each is tested, and none changes how an Ember rule behaves for data that Ember itself can produce.

| Topic              | Ember                                                                      | Unhollowed                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Days before start  | Open on an active habit. Checking one moves `start_date` back to that day  | **Inactive.** The backend rejects them. Backfilling means changing the start date first (U2-P4-05). A completion never changes a habit's dates                                                                        |
| Month columns      | Every active habit, in every month, because its pre-start days are open    | Only habits eligible on at least one day of the month, active or archived, because pre-start days are inactive here                                                                                                   |
| Writing a cell     | `toggle` flips the stored state                                            | `set` takes the wanted state and is idempotent, so a repeated or stale request cannot undo the user's last click                                                                                                      |
| Restoring a habit  | Not possible. "Restore" in Ember means replacing all history from a backup | **Restore** clears `archived_on`. The habit is continuous again: the days it spent archived become eligible and can be backfilled. No completion is added or removed. Refused while an active habit has the same name |
| Reorder            | Swap with the nearest active neighbor                                      | Save a whole new order in one transaction. Archived habits keep their places unless the new order moves them                                                                                                          |
| Individual streaks | None. Only the practice streak across all habits                           | Added per habit in U2-P4-08, beside the unchanged practice streak                                                                                                                                                     |
| Backup restore     | Replaces the whole database after a pre-restore copy                       | Imports copy into the active workspace and never replace other records. Replacing habit history, if added, belongs to U2-P4-07                                                                                        |
| Storage            | One database per app                                                       | Habits live in the workspace database beside documents, issues, and events. No second SQLite file                                                                                                                     |

## Unhollowed storage

Migration `0026_habits.sql` adds two `STRICT` tables.

**`habits`**: `id`, `workspace_id`, `name`, `name_key`, `position`, `start_date`, `archived_on`, `source`, `source_id`, `revision`, `created_at`, `updated_at`.

- Dates are checked with `date IS strftime('%Y-%m-%d', date)`, which refuses text that is not a real `YYYY-MM-DD` day, such as `2027-02-29`.
- `archived_on` is null or not earlier than `start_date`.
- Unique: `(workspace_id, position)`; `(workspace_id, name_key)` where `archived_on IS NULL`; `(workspace_id, source, source_id)` where `source_id IS NOT NULL`.
- A habit's workspace cannot change.

**`habit_completions`**: `habit_id`, `workspace_id`, `date`, `created_at`, primary key `(habit_id, date)`, index `(workspace_id, date)`.

- The primary key makes a duplicate completion impossible.
- A trigger refuses a completion whose habit is in another workspace.
- Rows are deleted with their habit (`ON DELETE CASCADE`), because a completion cannot exist without it. Habits are deleted only through the reviewed deletion command.
- Eligibility depends on today and on later edits to a habit's dates, so Rust checks it on every write instead of a trigger.

## Commands

Every command resolves the active workspace in Rust and returns `{ code }` errors, like labels and issues.

| Command                     | Does                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `list_habits`               | All habits in order, archived included                                                |
| `create_habit`              | Name and optional start date (default today). Appends to the order                    |
| `rename_habit`              | Keeps the ID and completions                                                          |
| `reorder_habits`            | The workspace's full list of habit IDs in the new order, saved in one transaction     |
| `archive_habit`             | Sets `archived_on` to today, or to the start date if that is later                    |
| `restore_habit`             | Clears `archived_on`                                                                  |
| `get_habit_deletion_impact` | Completion count, first and last dates, and the habit's `revision`                    |
| `delete_habit`              | Needs the `revision` from the impact. Refused if the habit is active or changed since |
| `get_habit_month`           | Today, the month's visible habits, and their completions in that month, read together |
| `list_habit_history`        | Every completion date of one habit                                                    |
| `set_habit_completion`      | Habit, date, and wanted state. Refuses future, pre-start, and post-archive days       |

## Import sources (U2-P4-06)

| Source                                              | Recognized by                                                 | Handling                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Ember desktop database                              | SQLite file with `habits` and `completions`, `user_version` 1 | Opened read-only and never changed                                                                                                       |
| Ember desktop backup                                | JSON `format: "ember-backup"`, `version: 1`                   | Validated with Ember's rules: IDs, names, dates, unique order, archive not before start, completions eligible and unique, 32 MiB maximum |
| Ember website snapshot                              | JSON with `encoding: "daily-bitmask-v1"` and `schemaVersion`  | **Not a backup.** Refused with a message to import it into Ember desktop first, then bring that backup here                              |
| A newer Ember (`user_version` or `version` above 1) | The version field                                             | Refused without reading further, as created by a newer Ember                                                                             |

**Identity mapping.** Each Ember habit gets a new UUID. `source` is `ember` and `source_id` keeps its Ember ID, so a repeat import can be detected. Completions follow their habit. Dates are copied unchanged, and Ember's `archived_at` becomes `archived_on`. Imported habits are appended after the workspace's existing habits, in Ember's order.

**Conflicts.** Import never merges or overwrites. The whole import is refused, naming the habits, if any incoming Ember ID is already in the workspace or an incoming active habit has the name of an active habit here. The preview runs the same steps in a transaction and rolls back, so it reports exactly what the import would do, and the import re-checks inside its own transaction.

**Forward migration.** Unhollowed reads only Ember version 1. A later Ember format needs a new reader and fixture here before it is accepted.

## Parity fixtures

Synthetic data only; never commit real history. U2-P4-02 to U2-P4-04 and U2-P4-06 turn these into tests.

**F1, Ember v1 synthetic.** Ember's `desktop/src-tauri/tests/fixtures/v1-synthetic.sql`:

| Ember ID    | Name              | Order | Start      | Archived   | Completions            |
| ----------- | ----------------- | ----- | ---------- | ---------- | ---------------------- |
| `fedc…3210` | Synthetic walk    | 0     | 2028-01-01 | —          | —                      |
| `0000…0001` | Synthetic retired | 1     | 2027-12-01 | 2028-01-15 | 2028-01-10             |
| `0123…cdef` | Synthetic read    | 2     | 2028-02-01 | —          | 2028-02-28, 2028-02-29 |

Traced with today 2028-03-01:

- **December 2027:** one column, retired. Walk and read start later.
- **January 2028:** columns walk, retired. Read is hidden because it starts in February. Retired is open on 1–15 January (the 15th inclusive) and inactive from the 16th; the 10th is checked.
- **February 2028 (leap):** 29 rows. Columns walk, read. Retired is hidden: no February day is eligible. Read is checked on the 28th and 29th.
- **Import:** three habits appended in that order with `source_id` set, the retired one archived on 2028-01-15, and three completions. A second import is refused because the IDs exist.

**F2, the same data as an Ember backup.** `{ "format": "ember-backup", "version": 1, "habits": [...], "completions": [["0000…0001", "2028-01-10"], …] }` gives the same result as F1. Version 2 is refused. A completion on 2028-01-16 for the retired habit is refused as ineligible.

**F3, cell states** (today 2026-11-17, habit started 2026-11-05):

| Day        | Active habit               | Archived on 2026-11-12          |
| ---------- | -------------------------- | ------------------------------- |
| 2026-11-04 | Inactive (Ember: open)     | Inactive                        |
| 2026-11-05 | Open                       | Open                            |
| 2026-11-12 | Open                       | Open (archive day is inclusive) |
| 2026-11-13 | Open                       | Inactive                        |
| 2026-11-17 | Open, highlighted as today | Inactive                        |
| 2026-11-18 | Future                     | Future                          |

**F4, February rows.** 2027 has 28 rows, 2028 has 29, 2100 has 28, and 2000 has 29.

**F5, failed save.** A rejected `set_habit_completion` leaves the cell as it was, keeps focus on it, and shows the error with a way to retry.

**F6, website snapshot.** A JSON file with `encoding: "daily-bitmask-v1"` is refused by the importer and never read as a backup.
