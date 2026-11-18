# Backup, restore, and upgrade

Validation for U2-P6-07. Commit `e76fc3a` plus the tests in this change, macOS arm64, disposable databases only.

## What each export covers

There is **no in-app full-workspace backup**. The built-in exports are partial. The supported full backup is a copy of the database file (below).

| Data                                               | Project JSON | Habit backup |           Calendar ICS            |     Document file     | Database file copy |
| -------------------------------------------------- | :----------: | :----------: | :-------------------------------: | :-------------------: | :----------------: |
| Projects, goals, milestones, labels                |     Yes      |      No      |                No                 |          No           |        Yes         |
| Issues, relationships, labels on issues            |     Yes      |      No      |                No                 |          No           |        Yes         |
| Document text and formatting                       |      No      |      No      |                No                 | One document per file |        Yes         |
| Embedded images                                    |      No      |      No      |                No                 |    Inside the file    |        Yes         |
| Issue and project document links                   |      No      |      No      |                No                 |          No           |        Yes         |
| Calendar events, recurrence, exceptions, reminders |      No      |      No      | Events, with supported recurrence |          No           |        Yes         |
| Habits and completion history                      |      No      |     Yes      |                No                 |          No           |        Yes         |
| Mood, energy, focus check-ins                      |      No      |      No      |                No                 |          No           |        Yes         |
| Dashboards and saved views                         |      No      |      No      |                No                 |          No           |        Yes         |
| Document revision history                          |      No      |      No      |                No                 |          No           |        Yes         |

Restoring a partial export never replaces other data: project JSON imports as new copies, habit restore replaces habits only (after a private copy and a preview), ICS import adds events and skips ones it already imported.

## Supported full backup and restore

Back up:

1. Quit Unhollowed 2 completely.
2. Copy `workspace.sqlite3` from the app data folder (`~/Library/Application Support/dev.arlecchino.unhollowed2/` on macOS, the matching `%APPDATA%` folder on Windows) to a safe place. Do not copy while the app is running: the database uses a rollback journal, and a copy taken during a write can be inconsistent.

Restore:

1. Quit the app. Keep a copy of the current `workspace.sqlite3` first: restoring **replaces the whole workspace**, and there is no merge.
2. Put the backup file in the app data folder under the name `workspace.sqlite3`. Start the app.

Document images, revisions, calendar data, habits, check-ins, and dashboards are in that one file, so the copy is complete.

## Upgrades

Updating the app is installing a newer build over the old one. On first start the app runs the new migrations on the existing file (forward-only). The old file's data is kept.

- **Older file, newer app:** supported. Migrations run in order.
- **Newer file, older app:** refused. The app will not open a file that has migrations it does not know, and does not change it. Install the newer app or restore an older backup.
- **Before upgrading**, take a file copy as above. A migration is transactional, but a copy is the only way back from a bug.

## Uninstall and reinstall

Expected, to be confirmed on the packaged apps (U2-P6-17, U2-P6-18) because installers were not run here:

- The app data folder, which holds the database, is created by the app and not by the installer. A normal uninstall (dragging the app to the Trash on macOS, the Windows uninstaller) is expected to leave it in place, so a reinstall opens the same workspace.
- Removing the data folder by hand deletes the workspace permanently. Unsaved document drafts are in webview storage in the same user profile and follow the same rule.
- Never rely on the installer to preserve or delete data: copy the file first.

## Evidence

`src-tauri/src/backup_tests.rs`:

| Test                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a_copy_of_the_closed_database_restores_every_module_exactly`  | Fills projects, issues with a relationship, a document with an image and an issue link, a recurring event, a habit with a completion, a check-in, and a dashboard; copies the closed file; restores it into a fresh disposable database. Every table matches row for row in both directions (SQL `EXCEPT`), `integrity_check` is `ok`, `foreign_key_check` is empty, and the same migrations then run and accept a new record. The test fails if any of the 11 listed tables is empty. |
| `a_backup_from_an_older_release_upgrades_without_losing_a_row` | A file from migration 5 keeps its issue id and project link after the current migrations run, and passes `integrity_check`.                                                                                                                                                                                                                                                                                                                                                            |
| `an_older_app_refuses_a_newer_database_without_touching_it`    | Older migrations on a newer file return an error and leave rows and integrity unchanged.                                                                                                                                                                                                                                                                                                                                                                                               |

Per-feature backup tests already exist for habits (`habits/backup_tests.rs`, restore replaces habits only, rolls back on failure, undo from the pre-restore copy) and project JSON (`portability/tests.rs`).

## Gaps and findings

| ID    | Severity | Finding                                                                                                                                                                                  | Status                                                                                                                                                      |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BAK-1 | Medium   | No in-app full backup or restore. Users must copy the database file by hand, and a restore replaces everything. Mood, dashboards, and documents have no other export that restores them. | Open. Record as a known limitation in the beta release notes (U2-P6-21); an in-app backup is new product scope and out of this gate. Owner decision needed. |
| BAK-2 | Low      | Copying while the app is running is unsafe and the app does not prevent it.                                                                                                              | Documented above.                                                                                                                                           |

- Packaged installers, uninstall, reinstall, and in-place upgrades were not run, and Windows was not run. The upgrade evidence is migration-level.
- A restored file's Windows and macOS path behavior was not compared across platforms.
