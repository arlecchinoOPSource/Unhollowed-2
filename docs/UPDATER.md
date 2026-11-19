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
- **Later work.** Download progress and the butterfly visuals are U2-P7-05. Installation and relaunch are U2-P7-06.

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
