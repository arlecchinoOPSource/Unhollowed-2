# Application identity and storage migration policy

Decision record for U2-P6-08. No identifier was changed. Commit `e76fc3a`.

## Current identity

| Item                   | Value                                                     | Source                           |
| ---------------------- | --------------------------------------------------------- | -------------------------------- |
| Bundle identifier      | `dev.arlecchino.unhollowed2`                              | `src-tauri/tauri.conf.json`      |
| Product name           | `Unhollowed 2` (window title and installer name)          | `tauri.conf.json`                |
| Crate and package name | `unhollowed-2`                                            | `Cargo.toml`, `package.json`     |
| Version                | `0.1.0`                                                   | Finalized in U2-P6-16            |
| Database file          | `workspace.sqlite3`, opened as `sqlite:workspace.sqlite3` | `tauri.conf.json`, `database.rs` |

Observed on macOS: the app data folder `~/Library/Application Support/dev.arlecchino.unhollowed2/` exists and holds `workspace.sqlite3`. This confirms the data location is derived from the identifier. Windows paths below come from Tauri's documented behavior and were not observed.

## Where the identifier shows up

| Surface                               | macOS                                                                                           | Windows x64 (expected, confirm in U2-P6-18)                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database and app data folder          | `~/Library/Application Support/<identifier>/`                                                   | `%APPDATA%\<identifier>\`                                                                                                                                            |
| Webview storage (drafts, preferences) | Under `~/Library/WebKit/` and `~/Library/Caches/`, keyed by bundle id                           | `%LOCALAPPDATA%\<identifier>\EBWebView`                                                                                                                              |
| Installed app identity                | `CFBundleIdentifier` in the `.app`; Gatekeeper, notifications, and permission prompts key on it | Installer product identity: the MSI upgrade code is derived from the identifier unless set explicitly, and NSIS registry entries use the product name and identifier |
| Notifications                         | Delivered under the bundle id                                                                   | Grouped under the app identity                                                                                                                                       |

## Consequences of changing it

| Area                   | Effect of a new identifier                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application data       | The new app looks in a new empty folder. The old `workspace.sqlite3` is untouched but no longer found: the workspace appears lost.                                                                                         |
| Existing beta users    | Same as above, plus drafts and preferences in webview storage (a separate folder) are orphaned too.                                                                                                                        |
| Installed app identity | The OS sees a different app: the old one is not replaced, and both can be installed side by side.                                                                                                                          |
| Windows upgrades       | A new MSI upgrade code means the installer cannot upgrade the old install in place. It installs beside it.                                                                                                                 |
| macOS                  | A new bundle id is a new app to Gatekeeper, notification permissions, and any Developer ID notarization record.                                                                                                            |
| Future signing         | Certificates and notarization are tied to the developer, not the identifier, but provisioning, entitlements, and keychain items that name the identifier must match the one shipped. Decide before the first signed build. |
| Future auto-update     | There is no updater today. Updates verify a signature and install over the same identity; an identifier change would split users into two update streams. Choose the permanent value before adding one.                    |

## Decision

**Recommendation: retain `dev.arlecchino.unhollowed2` as the permanent identifier.**

- Nothing has shipped publicly (the first beta is `v1.0.0-beta.1`), so the only data under this identifier is development data. A change costs the least it ever will right now, but nothing in the code needs it.
- It is a valid reverse-DNS identifier with no reserved suffix (the test below checks this).
- The product name `Unhollowed 2` is separate and can still be changed for display without moving data, because only the identifier names the data folder.

**Owner decision needed before the beta is published** (not decidable from the code): the identifier uses `arlecchino.dev`. Confirm the owner controls or intends to keep that domain, since reverse-DNS identifiers are conventionally tied to one. If not, change it **before** any public release using the plan below, not after.

## Migration plan if the identifier must change

Do this before the first public beta, in its own PR:

1. Change `identifier` in `tauri.conf.json` and update `tests/unit/identity.test.tsx`.
2. On first start, if the new data folder has no `workspace.sqlite3` and the old folder has one, copy the old file to the new folder (copy, never move), run the normal migrations on the copy, and leave the original in place.
3. Show a one-time notice naming the old folder so the user can delete it after verifying.
4. Test on disposable folders: old-only, new-only, both present (new wins, nothing overwritten), and a failed copy (app starts empty with a clear error, never overwriting).
5. For Windows, set the MSI upgrade code explicitly to the old derived value so installers still upgrade in place.
6. Webview drafts and preferences are not migrated; they are recoverable state, not records (see [Recovery](RECOVERY.md)).

## Guard

`tests/unit/identity.test.tsx` fails if the identifier changes, is not reverse-DNS shaped, ends in `.app`, or if the preloaded database name changes. Updating that test is the explicit step that confirms the change was intended.

## Gaps

- Windows installer identity, upgrade-in-place, and storage paths were not observed (no Windows run here). Confirm in U2-P6-17 and U2-P6-18.
- Domain ownership of `arlecchino.dev` is unknown to this review.
