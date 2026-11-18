# Release readiness review and GitHub prerelease checklist

Final gate for **`v1.0.0-beta.1`**, a **pre-release** (U2-P6-22). Reviewed commit: `4f6ad7e` (`main` after #248), 2026-11-18. **Nothing has been published, tagged, or version-bumped, and this document does not authorize publication.**

## Verdict: not ready to publish

The remaining release blockers include signing, the version bump, the first tagged packaging run, and native acceptance. The owner has approved MIT and Arlecchino as copyright holder and publisher.

Status key: **Met** (current evidence on this commit), **Partly** (evidence with a stated gap), **Not met**, **Owner** (needs an owner decision).

## Blocking requirements

| #   | Requirement                                            | Status                                            | Evidence                                                                                                                                                                                                                                                                                                                                               | What is left                                                                                                                                                                                             |
| --- | ------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Critical security findings resolved                    | **Met**, with one owner deferral                  | [Security](SECURITY.md): no critical or high finding in the audited areas; trust-boundary test in CI. [Dependencies](DEPENDENCIES.md): runtime has no unaddressed advisory except bundled SQLite (CVE-2026-119375, local file attacker), **deferred** pending a stable `sqlx` 0.9 and `tauri-plugin-sql` 3.                                            | **Owner:** approve the SQLite deferral for the beta or hold. Check WebView2 CSP behavior on a packaged Windows build (SEC-5).                                                                            |
| 2   | No known data-loss defects                             | **Partly**                                        | [Recovery](RECOVERY.md), [Errors](ERRORS.md), [Backup](BACKUP.md): failed saves never show saved, drafts journaled, crash and lock tests pass, migrations roll back. Documented risks remain: copying only `workspace.sqlite3` after a crash can lose recent changes (BAK-2, WAL); draft journal durability after a forced kill is unmeasured (REC-2). | **Owner:** accept BAK-2 and REC-2 as documented limitations (they are in the release notes), or add an in-app backup first.                                                                              |
| 3   | Core acceptance workflows pass                         | **Partly**                                        | [Acceptance](ACCEPTANCE.md): the 15-step workflow passes on a real SQLite file with restart (`beta_workflow`); Browser suites for every area pass.                                                                                                                                                                                                     | The same journey through the **real desktop window** on macOS and Windows has not been run (manual checklist in Acceptance). Independent usability testing (#217) is **not run**.                        |
| 4   | Database upgrades validated                            | **Met**                                           | [Data model](DATA_MODEL.md) integrity audit: all 24 steps from migration 5, shipped migrations pinned by hash; packaged macOS app and a **real Windows runner** both upgraded a migration-5 database to 29 with data intact.                                                                                                                           | None for the beta.                                                                                                                                                                                       |
| 5   | Backups and restoration work                           | **Partly**                                        | [Backup](BACKUP.md): a file-copy restore compared row for row across 11 populated modules; habit backup and restore tests; older-app refusal of newer files.                                                                                                                                                                                           | There is no in-app full backup (BAK-1). Manual procedure only. **Owner** decision to ship with that.                                                                                                     |
| 6   | macOS packages tested                                  | **Partly**                                        | [macOS](MACOS_DISTRIBUTION.md): the unsigned app was installed, relaunched, upgraded, and uninstalled on Apple Silicon (macOS 26.5.1); full icon set fixed.                                                                                                                                                                                            | The **CI-built DMG has never been inspected**: the macOS runner job was cancelled for lack of capacity. Minimum macOS version untested.                                                                  |
| 7   | Windows installers tested                              | **Met** for the tested machine                    | [Windows](WINDOWS_DISTRIBUTION.md): NSIS and MSI installed, started, relaunched, upgraded, uninstalled on a real Windows Server 2025 x64 runner; 11 of 11 checks.                                                                                                                                                                                      | Installer-over-installer, Windows 10 and 11 client machines, and a PC without WebView2 are untested.                                                                                                     |
| 8   | Signing and notarization for the intended distribution | **Not met**                                       | Steps documented for both platforms; no credentials exist; installers report `NotSigned` and Gatekeeper rejects the build.                                                                                                                                                                                                                             | **Owner:** decide between an unsigned internal beta (say so in the release) and a signed, notarized public beta (needs an Apple Developer account and a Windows code-signing certificate).               |
| 9   | Application identity finalized                         | **Owner**                                         | [Identity](IDENTITY.md) recommends retaining `dev.arlecchino.unhollowed2`. The publisher is Arlecchino.                                                                                                                                                                                                                                                | Confirm the domain and approve retaining the identifier.                                                                                                                                                 |
| 10  | License and privacy documentation completed            | **Verify on candidate**                           | [Legal](LEGAL.md) records the MIT decision. The license and dependency notices are bundled. The [privacy statement](PRIVACY_STATEMENT.md) describes local storage.                                                                                                                                                                                     | Verify the notice files in the final installers.                                                                                                                                                         |
| 11  | Release artifacts match the reviewed commit            | **Not met** (mechanism built, never run on a tag) | [Release](RELEASE.md): `verify-tag` requires tag = version, commit on `main`, Quick CI green; `BUILD-INFO.txt` records the commit. Verified by 13 unit tests and a Windows dispatch run.                                                                                                                                                               | The version is still `0.1.0`: a release PR must set `1.0.0-beta.1` everywhere and the MSI version (`0.99.N`, [Versioning](VERSIONING.md)). The `verify-tag` job has not run on a real tag; do a dry run. |
| 12  | Checksums generated and verified                       | **Partly**                                        | `SHA256SUMS` is written and was printed on a real Windows run.                                                                                                                                                                                                                                                                                         | macOS leg not exercised. Verify the downloaded files against `SHA256SUMS` on the release candidate.                                                                                                      |
| 13  | Known issues documented                                | **Met**                                           | [Release notes](release-notes/v1.0.0-beta.1.md) and the [user guide](USER_GUIDE.md) list limitations and installer limits.                                                                                                                                                                                                                             | Re-check against the final candidate.                                                                                                                                                                    |
| 14  | Release notes reviewed                                 | **Not met**                                       | Draft written.                                                                                                                                                                                                                                                                                                                                         | **Owner** review and approval; update the test results for the final commit.                                                                                                                             |

## Process notes the owner should know

- **Merged without hosted CI results.** Several earlier PRs in this batch were merged on the local `npm run test:mac` pass before the hosted Quick CI had reported. One of them (#240) introduced a test that failed intermittently on Linux; it was fixed in #246. Check that Quick CI is green on `main` before tagging.
- **Closed with gaps.** Some issues were closed when their PR merged although a part of their acceptance criteria could not be met here: #214 (native-window run), #222 and #223 (signing and notarization), #224 (tag path on a real tag), #226 (owner review). Those gaps are listed above. #217 was closed by mistake and reopened; #225 is open.
- The macOS packaging run cancelled for runner capacity, not for a code failure.

## Open decisions (owner)

1. Approve version `1.0.0-beta.1` and the `0.99.N` MSI mapping.
2. License decision recorded: MIT, copyright © 2026 Arlecchino, publisher Arlecchino.
3. Signing: unsigned internal beta, or Developer ID and a Windows certificate.
4. Accept the deferrals: bundled SQLite advisory, manual-only backup (BAK-1, BAK-2), Word import loss (DOC-1), minimum macOS version, and the untested configurations.
5. Whether independent usability testing (#217) is required before this beta.
6. Approve the release notes.

## GitHub Release checklist

Do these in order on the release candidate commit. Tick each box only with evidence.

**Prepare**

- [ ] Owner decisions above recorded (link or paste them in the release PR).
- [ ] Release PR merged: version `1.0.0-beta.1` in `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`; dated `## 1.0.0-beta.1` changelog heading; explicit `bundle.windows.wix.version`; `LICENSE` and SPDX fields; `bundle.copyright` and `bundle.publisher`.
- [ ] `npm run notices -- --check` passes (after `cargo fetch --locked --target x86_64-pc-windows-msvc`).
- [ ] Quick CI is green on the merge commit on `main`.
- [ ] `npm run test:mac:full` passes locally on Apple Silicon. Record the commit and macOS version.

**Build and verify**

- [ ] Tag the reviewed commit: `git tag -s v1.0.0-beta.1 <sha>`; push it. (Pushing the tag starts packaging.)
- [ ] The `Verify release tag` job passes. If it fails, fix the cause; never bypass.
- [ ] `Desktop packaging` succeeds for Windows and macOS. If macOS is cancelled for capacity, re-run the failed job.
- [ ] Download both artifacts. `BUILD-INFO.txt` shows the tag's commit. Verify each file against `SHA256SUMS`.
- [ ] Run the **Windows installer test** workflow, and install the macOS DMG on a clean Apple Silicon Mac. Record the results.
- [ ] Sign and notarize if the decision was to distribute publicly; verify with `signtool verify /pa` and `spctl -a -vvv -t exec`, `xcrun stapler validate`.
- [ ] Run the manual native workflow on each platform (see [Acceptance](ACCEPTANCE.md)) and, if required, the usability sessions.

**Draft the release (still unpublished)**

- [ ] Final release notes updated with the candidate's test results.
- [ ] Create a **draft** pre-release, never a published release:

```sh
gh release create v1.0.0-beta.1 --draft --prerelease \
  --title "Unhollowed 2 v1.0.0-beta.1" \
  --notes-file docs/release-notes/v1.0.0-beta.1.md \
  "Unhollowed 2_1.0.0-beta.1_aarch64.dmg" \
  "Unhollowed 2_1.0.0-beta.1_x64-setup.exe" \
  "Unhollowed 2_1.0.0-beta.1_x64_en-US.msi" \
  SHA256SUMS BUILD-INFO.txt
```

- [ ] Open the draft and confirm: tag, pre-release flag **on**, the five assets, checksums match, notes render, unsigned warning present if unsigned.

**Authorization and publication**

- [ ] The owner reviews the draft and approves publication in writing.
- [ ] Only then publish the draft. Publication must not be automated and must not happen from this repository's workflows.

### Owner authorization record

```
Release: v1.0.0-beta.1 (pre-release)
Commit: ____________________
Decisions recorded (1 to 6 above): ____________________
Authorized to publish by: ____________________   Date: ____________
```

## Evidence index

[Security](SECURITY.md) · [Dependencies](DEPENDENCIES.md) · [Privacy verification](PRIVACY.md) · [Privacy statement](PRIVACY_STATEMENT.md) · [Data model and integrity](DATA_MODEL.md) · [Recovery](RECOVERY.md) · [Backup](BACKUP.md) · [Identity](IDENTITY.md) · [Acceptance](ACCEPTANCE.md) · [Document compatibility](DOCUMENT_EDITOR.md) · [Usability protocol](USABILITY_TESTING.md) · [Performance and accessibility](PERFORMANCE.md) · [Errors](ERRORS.md) · [Versioning](VERSIONING.md) · [macOS](MACOS_DISTRIBUTION.md) · [Windows](WINDOWS_DISTRIBUTION.md) · [Release](RELEASE.md) · [Legal](LEGAL.md) · [User guide](USER_GUIDE.md) · [Release notes](release-notes/v1.0.0-beta.1.md)
