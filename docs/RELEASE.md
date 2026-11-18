# Release preparation

The version, increment rules, and a Windows MSI constraint are in [Versioning](VERSIONING.md). Installer checks per platform are in [macOS](MACOS_DISTRIBUTION.md) and [Windows](WINDOWS_DISTRIBUTION.md).

Use SemVer and version tags such as `v1.0.0-beta.1`. Update the npm manifest and lockfile, Rust manifest and lockfile, Tauri configuration, and changelog in one release PR. For Windows MSI, confirm that the numeric version fits Windows Installer constraints and increases across installer upgrades.

0. Choose the license ([Legal](LEGAL.md)) and run `npm run notices -- --check` (after `cargo fetch --locked --target x86_64-pc-windows-msvc`); regenerate if it fails.
1. Review the release PR and verify Quick CI and local macOS full checks.
2. Validate the candidate from a reviewed ref using **Desktop packaging → both**. When authorized, push the version tag from the reviewed commit to build both platform packages again.
3. Download the artifacts for that exact commit. Install the Windows x64 NSIS and MSI packages on clean Windows test machines and verify WebView2 startup, local storage, upgrades, and uninstall. On Apple Silicon, mount the DMG, install the app, and check startup, local storage, and upgrades.
4. Produce distribution packages with separately managed signing credentials. Sign Windows installers and binaries with a trusted certificate and verify them with SignTool. For direct macOS distribution, use Developer ID signing, notarize and staple, then verify code signing and Gatekeeper acceptance. The validation workflow creates unsigned artifacts for testing.
5. Once explicitly authorized, a maintainer creates a draft GitHub Release from the tag, uploads the verified distribution installers and SHA-256 checksums, and reviews the notes and assets. Mark beta versions as prereleases before publishing.

The current workflows upload temporary validation artifacts. There is no release publication job or automatic updater. See [Tauri distribution](https://v2.tauri.app/distribute/) for installer and signing procedures.

## What the packaging workflow checks (U2-P6-19)

`Desktop packaging` only validates. It has read-only permissions, creates no release, and publishes nothing.

| Requirement                          | How it is met                                                                                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproducible inputs                  | Pinned Node (`.nvmrc`) and Rust (`rust-toolchain.toml`), `npm ci`, `--locked` Cargo, and every action pinned to a full commit SHA. Not checked: byte-identical installers (bundles embed timestamps).                                                     |
| Tag matches the code                 | On a `v*` tag push, `verify-tag` runs first: the tag must be `v` plus the SemVer version in `package.json` and `tauri.conf.json` (`scripts/verify-release-tag.sh`).                                                                                       |
| Only reviewed code                   | The same job requires the tagged commit to be reachable from `origin/main`.                                                                                                                                                                               |
| CI passed first                      | The job asks the GitHub API for the `Quick checks (Ubuntu)` result for that exact commit and fails unless it succeeded. Packaging does not start otherwise (`package` needs `verify-tag`). Never bypass this by disabling the check.                      |
| Validation separate from publication | There is no publish job. A maintainer creates the draft release by hand ([steps above](#release-preparation)). A publish job, if added, must be a separate workflow that needs an approved environment.                                                   |
| Correct architecture labels          | `scripts/verify-artifacts.sh` requires Windows `x64` and macOS `aarch64` in the installer names, and fails on any other installer in the folder.                                                                                                          |
| Complete builds                      | The same script requires the NSIS setup **and** the MSI on Windows, or the DMG on macOS, and rejects empty files. A missing MSI no longer passes because the setup exists.                                                                                |
| Checksums                            | `SHA256SUMS` is written for each installer and uploaded with them. Check a download with `sha256sum -c SHA256SUMS` (Linux), `shasum -a 256 -c SHA256SUMS` (macOS), or `Get-FileHash` (Windows).                                                           |
| Provenance                           | `BUILD-INFO.txt` records the commit, ref, run ID and attempt, runner OS and architecture, and version. GitHub artifact attestations are not enabled: they need a plan that supports them for private repositories. Revisit when the repository is public. |
| Signatures                           | The job records `Get-AuthenticodeSignature` on Windows installers and `codesign -dv` on the macOS app in the run summary. Unsigned validation builds report `NotSigned` or an ad-hoc signature; they are not for distribution.                            |
| No accidental publication            | Workflow permissions are `contents: read`; artifacts expire after 7 days; nothing uploads to a release.                                                                                                                                                   |
| Failed or incomplete builds          | `fail-fast` is off so one platform's failure does not hide the other's; an incomplete platform fails its job and uploads nothing. Re-run only the failed job (`Re-run failed jobs`); do not weaken a check to get a release out.                          |

### Previous Actions failures reviewed (2026-11-18)

| Observation                                                                                                                        | Cause                                                                                | Response                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First Quick CI run failed before any step ([CI](CI_CD.md))                                                                         | Account payments or the Actions spending limit                                       | Resolved in billing; keep an eye on spend and re-run, never bypass.                                                                                             |
| `Package macos` cancelled after about 15 minutes, `The job was not acquired by Runner of type hosted even after multiple attempts` | GitHub's macOS arm64 runner capacity ("longer queue times"), not the code            | Re-run the failed job. The macOS DMG has therefore not been inspected from CI yet ([macOS](MACOS_DISTRIBUTION.md)). Plan release timing for macOS queue delays. |
| `Package windows` failed with `optional pre-release identifier ... numeric-only`                                                   | `1.0.0-beta.1` cannot be an MSI version                                              | Release PR sets `bundle.windows.wix.version` ([Versioning](VERSIONING.md)).                                                                                     |
| One Quick CI failure on `after_a_crash_only_a_copy_of_all_database_files...`                                                       | A flaky test I wrote assumed the pool close checkpoints the WAL; on Linux it did not | Fixed here with an explicit checkpoint.                                                                                                                         |
| About a dozen Quick CI runs `cancelled`                                                                                            | By design: a newer push to a pull request cancels the older run                      | None.                                                                                                                                                           |

### What was exercised

- `scripts/verify-release-tag.sh` and `scripts/verify-artifacts.sh`: 13 unit tests with fixtures, including a mismatched tag, a commit off main, a missing MSI, a wrong architecture label, a stale extra installer, and an empty file (`tests/unit/releaseScripts.test.tsx`).
- The staging, verification, checksum, signature, and upload steps ran successfully on a real Windows runner via a manual dispatch of this branch; the run printed both SHA-256 sums and `NotSigned` for each installer.
- The CI-status query used by `verify-tag` was run against two commits on `main` and returned `success`.
- **Not exercised:** the `verify-tag` job on a real tag push (no tag exists yet), the macOS leg (runner capacity), and a failing-CI tag. Run the first release tag as a dry run and read the `verify-tag` job before trusting the macOS leg.
