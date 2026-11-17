# Phase 3 verification: Calendar and scheduling

This records the U2-P3-19 validation of Phase 3: what was run, the results, and the platform gaps that remain. The contract itself is in [Calendar and scheduling](CALENDAR.md). Performance numbers are in [Performance and accessibility](PERFORMANCE.md).

## Reproduce

From the repository root, with the pinned Node and Rust versions:

```sh
npm ci
npx playwright install chromium
npm run test:mac
npm run test:browser
cargo test --release --manifest-path src-tauri/Cargo.toml measure_calendar_sizes -- --ignored --nocapture
PERF=1 npx playwright test performance -g "calendar views" --reporter=line
```

Every Rust test uses an in-memory or temporary file database that is deleted afterward. Nothing touches a real workspace.

## Evidence by workflow

| Workflow                                                  | Where it is checked                                                                                                                                                                                                                 | Result                                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Create, schedule, link, remind, search, exchange, restart | `scheduling::journey` (Rust, two file databases): upgrades a version 19 database, creates an event, schedules work on an existing issue, links, reminds, searches, exports, imports into a second database, closes and reopens both | Pass. The issue's due date is unchanged, the reminder is not repeated, and both databases keep their data after reopening |
| The same flow through the UI                              | `tests/browser/phase3.spec.ts`, light and dark (mocked IPC: it checks the UI, not persistence)                                                                                                                                      | Pass in both themes                                                                                                       |
| Migrations                                                | Upgrade tests for scheduling (`0020`), links (from version 22), and reminders (from version 23), and the journey, which migrates version 19 through version 25 (`0025` imported UIDs are exercised by the ICS tests)                | Pass                                                                                                                      |
| Recurrence, time zones, all-day, DST                      | `scheduling::recurrence` and `scheduling::tests::temporal` (Rust), `agenda.test.tsx` (spring-forward and fall-back windows)                                                                                                         | Pass                                                                                                                      |
| Event search                                              | `scheduling::search` (Rust), `calendarSearch.test.tsx`, calendar browser tests                                                                                                                                                      | Pass                                                                                                                      |
| Drag persistence, resize, keyboard moves                  | `calendar.spec.ts` (drag, resize, keyboard proposals, failed save keeps the event)                                                                                                                                                  | Pass. One mouse-timing test is flaky, see below                                                                           |
| Existing issue and Month behavior                         | `IssueCalendar` browser tests and the issue Rust tests, all still passing                                                                                                                                                           | Pass                                                                                                                      |
| Reminders                                                 | `scheduling::reminders` (Rust, fake clock: once, edit, cancel, resume, DST, restart, disabled)                                                                                                                                      | Pass. Native delivery not seen, see gaps                                                                                  |
| ICS exchange                                              | `scheduling::ics` (Rust: fixtures, round trip, duplicates, invalid input)                                                                                                                                                           | Pass. Native dialogs and other calendar apps not exercised                                                                |
| Themes and keyboard                                       | `accessibility.spec.ts` (axe WCAG 2.2 AA in light and dark on every calendar view and panel, focus rings, 620 px reflow), `calendar keyboard` tests, `calendarKeyboard.test.tsx`                                                    | Pass                                                                                                                      |

## Results

macOS (Apple Silicon): `npm run test:mac` passed with 70 frontend tests and 178 Rust tests (3 ignored benchmarks). Chromium passed 84 tests, with 4 skipped PERF fixtures.

### Defect found and fixed

An export of more than 2,000 events could not be imported back: the importer refused files over 2,000 events while the exporter wrote any number. The limit is now 20,000 events, which a 5 MiB file reaches at roughly 17,000, so the size limit is the real bound. A 5,000-event file round trips.

### Flaky test, stabilized

`calendar.spec.ts` › `drags out a range, resizes, and confirms a moved appointment` is driven by real mouse movements and failed in roughly one of three full-suite runs. Two causes were fixed in the test: it now waits for each dialog to close, and for the timeline's scroll to the working day to settle before measuring the columns (a late scroll moved them mid-drag). The full suite then passed three runs in a row. It is timing-based, so watch it in CI.

## Platform gaps

| Area                              | macOS                                                      | Windows                               |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| Rust and Chromium test suites     | Run (above)                                                | Not run here. Quick CI runs on Ubuntu |
| Packaged app launch and restart   | Not run for Phase 3 features                               | Not run                               |
| Reminder notifications            | Not seen. Permission and Notification Center are unchecked | Not seen. Toast behavior is unchecked |
| Reminders with the app closed     | By design none on either platform                          | By design none                        |
| Native .ics open and save dialogs | Not run                                                    | Not run                               |
| .ics with other calendar apps     | Not exchanged with Apple Calendar                          | Not exchanged with Outlook            |
| Screen readers                    | VoiceOver not run                                          | Narrator and NVDA not run             |
| WebKit and WebView2 rendering     | Automated checks run in Chromium only                      | Same                                  |

To close the gaps, run `npm run desktop` on each platform against a disposable app identifier and:

1. Set a reminder 2 minutes ahead on a new event, then confirm one notification at the right time, and none after the event starts. Use **Send a test notification** to check the system setting.
2. Export from the calendar page, open the file in the platform's calendar app, edit an event there, export from it, and import that file here. Check that dates, all-day events, and a repeating event with an exception survive.
3. Create, drag, and link events, quit fully, reopen, and confirm everything is still there and no reminder repeats.
4. Walk the calendar with VoiceOver or Narrator: view switch announcements, event names (type, time, overlap), and the editor dialog.

## Performance

The recorded baseline and the gaps it found are in [Performance and accessibility](PERFORMANCE.md#calendar). No performance change was made in this phase, so nothing is claimed as improved.
