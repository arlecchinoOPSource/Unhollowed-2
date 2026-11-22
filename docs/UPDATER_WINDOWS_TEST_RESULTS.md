# Windows updater test results

Issue: [#258](https://github.com/arlecchinoOPSource/Unhollowed-2/issues/258). Related cross-platform acceptance: [#260](https://github.com/arlecchinoOPSource/Unhollowed-2/issues/260).

This is a record of the evidence available as of 22 November 2026, not a claim that all acceptance criteria passed. The owner chose to close #258 with the gaps below documented.

## Test context

- Candidate commit recorded in the test notes: `6d85540866a22d6e9a01bfd78f2ec38be96c3d06`.
- Windows Sandbox with NSIS and MSI; exact Windows build and artifact hashes were not recorded. Acceptance client: `1.1.0-beta.0`; candidate: `1.1.0-beta.1` via the isolated dry-run feed. The prior manual bootstrap began at `1.0.0-beta.1`.
- Use disposable profiles: the acceptance client shares the application and upgrade identity with ordinary installations. See [native updater acceptance](UPDATER_ACCEPTANCE.md).

## Recorded observations

| Scenario | Evidence and limits |
| --- | --- |
| NSIS and MSI in-app upgrade | The owner reported successful beta.0 to beta.1 upgrades and retained test records. NSIS Settings showed beta.1 and success notices were reported. A complete comparison for every data type was not recorded. |
| Manual bootstrap | The owner reported manual upgrades from `1.0.0-beta.1` to `1.1.0-beta.1` with both NSIS and MSI. During NSIS removal, the delete-data option was left unchecked. |
| Offline startup | The owner reported that the app started offline, existing data remained available, and a new document edit saved. |
| One-time success notice | On one later restart of the updated NSIS client, the owner observed the document still present and no repeated success notice. |
| Download initiated while offline | With beta.1 offered to the beta.0 NSIS acceptance client, the guest Ethernet adapter was disabled before selecting Download and install. The app reported it could not reach the update server and remained usable. A saved document reopened with its contents intact. Ethernet was restored; the client again offered beta.1 and reported beta.0 installed. This did not test an interruption during transfer. |
| Attempted transfer interruption | The update completed before a disconnect could be applied. The NSIS app relaunched with a beta.1 success notice and the test document intact. No mid-transfer interruption occurred; the result is **inconclusive** for that scenario. |
| Automated updater checks | Previous session reported 43 frontend and 22 Rust updater tests passed. The failed-save frontend case was mocked; signature and lock tests used controlled fixtures. These are not native failure-path evidence. |
| MSI timing | The owner observed about two minutes preparing and about two minutes in setup in Sandbox. The cause was not established. |

An additional NSIS upgrade was started accidentally before disconnecting; the owner reported checks passed and the saved document and beta.1 success notice were visible. It was a successful update, not an interrupted-download test.

## Unrun or insufficiently evidenced

- A genuinely interrupted transfer after some bytes have arrived; use a controlled slow or terminating test server and record evidence of the partial transfer.
- Native failed-save or pending-mutation failure proving that installer handoff is blocked; native failed-install recovery and its user guidance.
- A complete before/after comparison of documents, projects, issues, calendar, habits, mood, dashboards, preferences, paths and installer registration for each installer family.
- Captured startup and idle network evidence establishing no automatic updater request or background installation.
- Exact Windows build, signed artifact hashes, and comprehensive environment and fixture snapshots.
- Native macOS Apple Silicon acceptance; controlled malformed metadata, missing asset and invalid signature failure scenarios; and dry-run feed withdrawal. These also belong to the broader [#260](https://github.com/arlecchinoOPSource/Unhollowed-2/issues/260) acceptance work.

Closing #258 records the owner's decision to defer these checks; it does not establish that they passed or authorize production feed promotion. Release and acceptance decisions remain subject to the documented process.

