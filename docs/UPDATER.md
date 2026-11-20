# Updater

The update check added in U2-P7-02 (#254). It finds out whether the beta channel has a newer version. Downloading and installing come later (#258), and so does the sidebar control that calls the check (#256). Release packaging, the formats, and the manual bootstrap from `v1.0.0-beta.1` are covered in [Updater compatibility](UPDATER_COMPATIBILITY.md).

## Rules

- **The check runs only when the person asks.** Nothing checks at startup, on a timer, on resume, or in the background. Without a check, the app makes no network request and works offline as before.
- **One check at a time.** A second request while one runs returns `busy` and does nothing.
- **The webview gets no updater API.** `tauri-plugin-updater` is registered for Rust only. The window's capability still has no permissions, and `@tauri-apps/plugin-updater` is not installed. The webview calls one command, `check_for_update`, through `src/database/updates.ts`. The CSP is unchanged, because the request is made by Rust, not by the page.
- **Only newer versions are offered.** The plugin's default comparator accepts only a strictly greater SemVer version. A channel that still announces the same or an older version reports `current`. `allowDowngrades` and custom comparators are not used.

## Configuration

In `src-tauri/tauri.conf.json` under `plugins.updater`:

| Key         | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `endpoints` | `https://github.com/arlecchinoOPSource/Unhollowed-2/releases/download/updater-beta/latest.json` |
| `pubkey`    | The minisign public key. The owner holds the private key; it never enters the repository.       |

The endpoint is a fixed asset on a dedicated `updater-beta` release that holds only the beta manifest. Release automation (#259) updates it last, after approval. GitHub's `releases/latest` URL is not used, because it skips prereleases. The URL contains no version or platform parameters, so the request carries no information about the install.

`tests/unit/securityConfig.test.tsx` fails if the endpoint changes, if the key is missing, or if any `dangerous*` or `allowDowngrades` setting appears. Test feeds exist only in the Rust tests: a local HTTP server, with plain HTTP allowed in the test configuration and nowhere else. A production build cannot be pointed at another feed.

`requireSignedVersion` is on: a package must be signed for the exact version the manifest announces. Signing, the key, asset names, and the manifest are in [Updater signing](UPDATER_SIGNING.md).

## Interface (U2-P7-04)

- **Sidebar control.** The control at the bottom-left of the sidebar (`src/features/updates/UpdateButton.tsx`) has the accessible name and tooltip "Check for updates" and works by keyboard. It starts a check and opens the updater screen at `/updates`. It is the only thing that starts a check.
- **States.** `src/features/updates/updateMachine.ts` defines the nine states: idle, checking, up to date, update available, downloading, verifying, installing, restarting, and error. `transition` is the only way to change state, and it ignores an event that does not apply, so late or repeated events cannot produce contradictory screens. A shared store (`updateStore.ts`) keeps one state for the whole app. It starts nothing while an operation is in flight, so repeated activation cannot begin a second one.
- **Leaving the screen.** The screen lives inside the normal workspace, so the sidebar stays usable. **Done** is offered whenever leaving is safe (idle, up to date, available, error, and during a check, which changes nothing), and it returns focus to the sidebar control. Errors explain what happened, say the workspace is not affected, and offer **Try again**, except on unsupported platforms.
- **Version.** Settings → About shows the installed version from the `app_version` command, so the window needs no extra permission.

## Download and progress (U2-P7-05)

- **Starting.** **Download and install** in the available state is the only way a download starts. `download_update` fetches only the update the last check found (kept in Rust as `PendingUpdate`), so the webview cannot choose a package or an address. It shares the one-operation lock with the check.
- **Progress.** The native download reports the bytes actually received through a Tauri `Channel`, at most every 100 ms. With a known total, the bar and text show a percentage and "2 MB of 8 MB". With a missing or zero total, the bar is indeterminate and only the downloaded size is shown. Nothing is estimated. Progress is not a live region; the status line announces each new state once.
- **Verification.** When every byte has arrived, the screen shows **Verifying update...** while the plugin checks the signature against the embedded key and the signed version ([Updater signing](UPDATER_SIGNING.md)). A package that fails verification is discarded and reported as "could not be verified". A verified package is kept in memory (`VerifiedPackage`) for installation.
- **Cancellation.** The plugin's download API offers no safe cancellation, so none is offered, and **Done** is hidden while downloading. The sidebar still works, and the download finishes or fails on its own.
- **Visuals.** The official butterfly (`BrandMark`, unchanged geometry) sits above the status. While an operation runs it breathes (a slight scale and opacity change) and its wings move gently. The working titles end in three dots that light in turn. Only `transform` and `opacity` animate, and only in busy states; a settled screen runs no animation. With reduced motion, the butterfly is still, the dots are solid, and the indeterminate bar is a still, lighter bar.

## Installation and restart (U2-P7-06)

**Download and install** is the person's confirmation to install. After the package verifies, the app installs it without asking again. Installing always ends in a restart or a hand-off to the platform installer. Unhollowed never claims to update in place, and there is no automatic rollback.

### What happens, in order

1. **Documents.** `flushDocumentWrites` saves every document edit still in memory and waits for all document saves. If any save fails, nothing is installed. The screen says "A document could not be saved", and the app and workspace stay open.
2. **Resume record.** The app stores `unhollowed-2-update-resume` in local storage: only the version being installed and the page the updater was opened from. No workspace data goes in it.
3. **Database.** `install_update` takes SQLite's write lock (`BEGIN IMMEDIATE`). This waits for any write in progress to commit and keeps new writes from starting, so the hand-off never cuts a mutation off (`handoff_tests` in `updates.rs`). If the lock cannot be taken within the busy timeout, nothing is installed and the lock is not held.
4. **Install.** The plugin verifies the package signature again, then:
   - **macOS:** replaces `Unhollowed 2.app` in place (asking for an administrator password if its folder is not writable), shows **Restarting Unhollowed...**, and restarts into the new version.
   - **Windows:** starts the NSIS setup or the MSI, matching the installed family, in passive mode, and exits the app. The installer replaces the program and starts Unhollowed again.
5. **After the restart.** `UpdateNotice` reads the resume record once and removes it. It compares the running version (`app_version`, local only) with the version that was installed:
   - **They match:** a small notice says "Unhollowed is up to date. Version X is installed.", and the app returns to the saved page. The workspace opens normally, with no second loading sequence.
   - **They differ:** the notice says the update did not finish, that the old version is still in use and the workspace was not changed, and links to **Try again**.

If installation fails before the restart, the resume record is removed, the write lock is released, and the screen shows "The update could not be installed" with the recovery steps below.

### What is preserved

The installers replace only the application. The workspace database (`workspace.sqlite3` in the app data folder named by `dev.arlecchino.unhollowed2`), webview preferences, and document drafts live outside the application and are not touched ([Updater compatibility](UPDATER_COMPATIBILITY.md), [Identity](IDENTITY.md)). IDs and paths do not change. New versions run their forward-only migrations on first start. Survival across upgrades is covered by the existing upgrade tests, for example:

- documents: `documents::tests::existing_databases_upgrade_without_losing_data`
- projects and issues: `issues::tests::upgrading_from_the_projects_schema_keeps_existing_records`
- calendars: `scheduling::links::tests::links_survive_a_restart_and_upgrade_from_the_previous_version`
- habits: `habits::schema_tests::upgrade_keeps_existing_data_and_habits_survive_reopen`
- dashboards: `dashboards::tests::upgrading_from_the_previous_schema_keeps_existing_data`
- everything together: `phase5_acceptance::upgrade_layouts_records_and_restart_keep_supported_data_and_recompute_the_same_analytics` and `backup_tests::a_backup_from_an_older_release_upgrades_without_losing_a_row`

### Recovery when installation fails

Nothing in the workspace changes in any of these cases. Back up first (**Settings → Backup**) if you want a copy before trying again.

| Installed with | What to do                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS DMG      | Quit Unhollowed, download the DMG from the releases page, drag the app to `/Applications`, and choose **Replace**. If the error says the previous app was left at a path, move that app back to `/Applications` first. If the app runs from the DMG or Downloads, move it to `/Applications`, because macOS will not let it be replaced there. |
| Windows NSIS   | Run the `-setup.exe` from the releases page. It installs over the current version for your user account.                                                                                                                                                                                                                                       |
| Windows MSI    | Run the `.msi` from the releases page with administrator rights. Windows Installer rolls back a failed MSI installation on its own. Do not switch to the NSIS setup.                                                                                                                                                                           |

If the app still reports the older version after a restart, the notice says so. Use **Try again**, or install by hand as above.

## Results

`check_for_update` always resolves; it never rejects. The result is tagged by `status`:

| `status`      | Fields                                                      | Meaning                                                                                                                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `available`   | `currentVersion`, `version`, `date`, `notes`                | A newer, valid release exists for this platform and installer.                                                                                                                                                                                                                                               |
| `current`     | `currentVersion`                                            | No newer release. This includes a channel announcing the same or an older version.                                                                                                                                                                                                                           |
| `unsupported` | `target`                                                    | The platform has no updater packages (only `darwin-aarch64` and `windows-x86_64` do; others are not contacted), or the channel lists no package for this platform or installer.                                                                                                                              |
| `busy`        |                                                             | Another check is running.                                                                                                                                                                                                                                                                                    |
| `failed`      | `reason` (`offline`, `invalidMetadata`, `server`), `detail` | Recoverable: nothing was downloaded or changed. `offline`: no connection or no answer within 30 seconds. `invalidMetadata`: the manifest is malformed, incomplete, has an invalid version, or names a non-HTTPS package. `server`: an error status such as 404. `detail` is the technical message, for logs. |

On Windows the plugin first looks for the installer-specific key (`windows-x86_64-nsis` or `windows-x86_64-msi`), then for `windows-x86_64`. Publish both installer keys, so an install only ever receives its own installer family.

## Tests

`src-tauri/src/updates.rs` runs the real plugin in Tauri's mock runtime against a local server that answers like the channel. The cases are: a newer release (`available` with its metadata); the same version, an older version, and an older prerelease (`current`); malformed JSON, a missing `platforms` field, an invalid version, and an HTTP package URL (`invalidMetadata`); a manifest without this platform (`unsupported`); an unpublished platform, which never contacts the channel; a closed port (`offline`); a 404 (`server`); a second check while one runs (`busy`, then the lock is released); and the serialized shape the webview receives. The mock runtime is enabled only for tests (`[dev-dependencies]` `tauri` feature `test`).

## Dependencies

`tauri-plugin-updater` 2.14.1 adds `reqwest` (rustls), `minisign-verify`, and archive crates. The normal macOS dependency graph grew from 349 to 404 crates. `cargo audit` reports the same 2 vulnerabilities and 6 warnings as the [dependency audit](DEPENDENCIES.md), and none in the new crates. `THIRD_PARTY_NOTICES.md` was regenerated.
