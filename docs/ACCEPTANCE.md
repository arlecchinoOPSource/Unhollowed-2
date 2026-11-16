# Projects & Issues acceptance

## Reproduce

From the repository root, use the pinned Node and Rust versions and run:

```sh
npm ci
npx playwright install chromium
npm run test:mac
npm run test:browser
```

On Windows, use the equivalent frontend and Rust commands in [Development](DEVELOPMENT.md). Build the desktop application and follow the manual steps below. Use a dedicated test app identifier and a disposable database. Never point a test run at your everyday workspace.

The new SQLite journeys also run with `cargo test --locked --manifest-path src-tauri/Cargo.toml acceptance_tests` after the frontend build. One creates a current-schema database. The other starts at migration 5 with a project, an issue, and a formatted document, applies the remaining migrations, and checks the original record IDs and document content. Both close and reopen the database during the workflow.

## Results

Run on Apple Silicon macOS 26.5.1. The Rust journeys use real SQLite and application persistence functions. Chromium exercises the UI with mocked Tauri IPC. Native smoke uses the packaged Tauri app and its own SQLite file.

| Scenario                                 | Reproduce and expected result                                                                                                                                      | Observed result                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Projects and issues                      | Create and edit a project and an issue. Verify the updated text and stable issue key after revisiting.                                                             | Pass in Chromium. Issue edit and ID persistence also passed in both SQLite journeys.           |
| Labels, milestones, and lifecycle        | Assign a label and milestone, complete the issue, reopen it, and verify the milestone and dashboard counts.                                                        | Pass in Chromium and both SQLite journeys.                                                     |
| Relationships and linked documents       | Add a sub-issue. Link a formatted document to the issue and project. Open the links and verify text and formatting survive.                                        | Pass in Chromium and both SQLite journeys.                                                     |
| Filters, saved views, and flexible views | Filter by project and label, save the query, reopen the saved view, switch list and board, and check date-based views.                                             | Pass in Chromium. Saved configuration persisted in both SQLite journeys.                       |
| Archive and restore                      | Archive a linked issue, reopen the database, restore the issue, and verify its metadata and links.                                                                 | Pass in Chromium and both SQLite journeys.                                                     |
| Dashboard                                | Compare open, closed, and milestone counts after completion, reopening, and restoring.                                                                             | Pass in Chromium and both SQLite journeys.                                                     |
| Upgrade and workspace isolation          | Apply current migrations to the disposable older fixture. Verify the existing document, issue and project ownership, and attempt reads from a different workspace. | Pass in the SQLite journeys. Native UI upgrade untested.                                       |
| Native macOS relaunch                    | From the isolated packaged app, open Issues, create a test issue, quit the application fully, reopen it, and find the same issue and key.                          | Pass. The packaged app showed the same ISS-1 before and after restart.                         |
| Native Windows x64                       | Repeat the native journey with a disposable workspace and record startup, linked content, upgrade, and restart.                                                    | Untested here. Tracked in [#53](https://github.com/arlecchinoOPSource/Unhollowed-2/issues/53). |

The macOS checks passed with 28 frontend and 106 Rust tests. Chromium passed 43 tests. Two Rust benchmarks and two Chromium performance tests were skipped under the regular test commands. The large-workspace relationship picker gap remains tracked in [#52](https://github.com/arlecchinoOPSource/Unhollowed-2/issues/52).
