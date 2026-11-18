# Security audit

Audit of Unhollowed 2 for the beta gate (U2-P6-01). Method: source review plus the automated checks listed at the end. Reviewed commit: `00cc1da` (main). Platform for executed checks: macOS Apple Silicon. Windows WebView2 behavior was not exercised (see Gaps).

## Threat model

Unhollowed 2 is a single-user, offline, local-first desktop app. There is no server, account, sync, telemetry, or auto-update.

| Asset                                      | Where                                  |
| ------------------------------------------ | -------------------------------------- |
| Workspace content (issues, documents, etc) | One SQLite file in the app data folder |
| User files opened or saved                 | Only through native dialogs, from Rust |
| OS resources (files, processes, network)   | Not reachable from the webview         |

| Attacker                                                                    | Entry point                                    |
| --------------------------------------------------------------------------- | ---------------------------------------------- |
| A hostile file the user imports (`.docx`, `.ics`, project JSON, habit JSON) | Importers                                      |
| Hostile text inside the user's own data (a pasted link, an event URL)       | Document and calendar rendering                |
| A compromised frontend dependency                                           | The webview, bounded by capabilities and CSP   |
| Another local user or process reading the data folder                       | Filesystem (out of scope: OS account boundary) |

Out of scope: an attacker with the user's OS account, physical access, and supply-chain compromise of the Rust toolchain (the dependency audit covers the latter, U2-P6-02).

## Trust boundaries and controls

1. **Webview to Rust (IPC).** The only capability, `src-tauri/capabilities/main.json`, has `"permissions": []`. The window can call the app's own `#[tauri::command]` functions and nothing from the SQL, dialog, or notification plugins. The SQL plugin is registered only to run migrations from Rust and cannot be reached from the webview.
2. **Content Security Policy.** Production: `default-src 'self'; connect-src ipc: http://ipc.localhost; font-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'`. No inline script, no eval, no remote origin. The looser `devCsp` applies only to `tauri dev`.
3. **Filesystem.** No fs, shell, http, opener, process, or updater plugin. Rust reads or writes a user file only after a native open or save dialog the user completes, with a size check before reading.
4. **SQLite.** Every query uses bound parameters. The three `format!` SQL strings (`documents/library.rs`, `issues/query.rs`, `portability.rs`) interpolate only compile-time constants (column lists, a `NOW` expression, fixed assignment clauses); no user value reaches them. Every record query filters by `workspace_id`.
5. **Rendering.** Documents render through ProseMirror schema nodes, not raw HTML. Imported Word HTML is parsed in an inert `<template>`, links are filtered through `safeWebLink` (`http`, `https`, `mailto` only), and images are replaced with managed assets or dropped. The only `innerHTML` uses (`importWord.ts`, `fileTransfer.ts`) write into detached templates.
6. **External URLs.** The app opens no URL itself (no opener plugin). Links in documents and events are stored as text and validated on entry.
7. **Local storage.** Preferences only; no secrets or credentials exist in the app.
8. **Data leakage.** No outbound network request is made by app code. Exports go only to the path the user picks.

## Command and capability inventory

| Item                         | Count / state | Notes                                                                                                                                                                  |
| ---------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capabilities                 | 1 (`main`)    | No permissions, no `remote` origins                                                                                                                                    |
| Registered Tauri commands    | 156           | All in `src-tauri/src/main.rs` `generate_handler!`; all scoped to the active workspace                                                                                 |
| Commands touching user files | 4 modules     | `portability.rs`, `scheduling/ics.rs`, `habits/backup.rs`, `habits/import.rs` are the only code calling a native open or save dialog. Each checks size before reading. |
| Commands starting a process  | 0             | No `Command::new` anywhere                                                                                                                                             |
| Commands making network I/O  | 0             |                                                                                                                                                                        |
| Plugins                      | 3             | `sql` (Rust only), `dialog` (Rust only), `notification` (system reminders)                                                                                             |

## Findings

| ID    | Severity | Finding                                                                                                                                                                                           | Status                                                                         |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| SEC-1 | None     | No critical or high issue found in the reviewed areas.                                                                                                                                            | Verified by the checks below                                                   |
| SEC-2 | Low      | `devCsp` allows `'unsafe-inline'` styles and a websocket. Dev builds only.                                                                                                                        | Accepted: not shipped in release bundles                                       |
| SEC-3 | Low      | `tauri-plugin-notification` is registered without a capability. Reminders fire from Rust, so no webview permission is needed, but a future change that adds a permission would widen the surface. | Mitigated: `securityConfig.test.tsx` fails if the capability stops being empty |
| SEC-4 | Info     | The SQLite file is not encrypted at rest. Protection relies on the OS account.                                                                                                                    | Accepted for a local-first beta; document in the privacy statement (U2-P6-20)  |
| SEC-5 | Info     | Windows WebView2 and macOS WKWebView enforce CSP slightly differently. Not exercised on Windows here.                                                                                             | Open: check on a packaged Windows build (U2-P6-18)                             |

## Verification

- `tests/unit/securityConfig.test.tsx` fails the build if: the capability gains a permission, a second capability appears, the production CSP gains `unsafe-inline`, `unsafe-eval`, a wildcard, or a remote origin, `withGlobalTauri` or an asset-protocol scope is enabled, or a shell, fs, http, opener, process, updater, or global-shortcut plugin is added.
- Malformed-input behavior is tracked in U2-P6-03, network behavior in U2-P6-04, database integrity in U2-P6-05.

## Gaps

- Windows was not run. WebView2 CSP behavior and the packaged app's data-folder permissions need a check on a Windows machine.
- This is a source audit with non-destructive checks. It is not a penetration test and no external reviewer has signed off.
