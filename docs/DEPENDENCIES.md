# Dependency and supply-chain audit

Audit for U2-P6-02. Date: 2026-11-18. Commit: `e76fc3a`. Platform: macOS Apple Silicon. Nothing was upgraded: the advisories below are either not shipped or need a breaking, pre-release upgrade (see decisions).

## Inventory

| Graph                          | Size                                       | Source                                        |
| ------------------------------ | ------------------------------------------ | --------------------------------------------- |
| npm, all (`npm ls --all`)      | 339 packages                               | `package-lock.json`, installed with `npm ci`  |
| npm, production (`--omit=dev`) | 109 packages                               | Bundled into the frontend                     |
| Cargo, macOS arm64             | 332 crates                                 | `src-tauri/Cargo.lock`, built with `--locked` |
| GitHub Actions                 | 5 actions, all pinned to a full commit SHA | `.github/workflows/*.yml`                     |

`npm audit signatures`: 145 packages have verified registry attestations, none failed.

## Advisories

| ID                                                                                           | Package                                                                      | Ships in the app?                                                                                           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GHSA-fc5q-39xc-vjpf (high, ReDoS)                                                            | `picomatch` via vite, vitest, typescript-eslint (12 packages in `npm audit`) | No. `npm audit --omit=dev`: 0 vulnerabilities                                                               | Not applicable. Dev-time glob matching on repository paths we control. `npm audit fix --force` would downgrade vitest to 3.1.4, a breaking change, so it is not applied. Re-check when vite or vitest publish a patched `picomatch` range.                                                                                                                                                                                                                                                                                  |
| [RUSTSEC-2026-0459](https://rustsec.org/advisories/RUSTSEC-2026-0459.html) / CVE-2026-119375 | Bundled `libsqlite3-sys` 0.30.1 via the current SQLx stack                   | Yes                                                                                                         | **Deferred for `1.0.0-beta.1`.** RustSec rates this local information-disclosure advisory 6.8 (medium). Exposure requires opening SQLite workspace files a less-trusted party can write. Unhollowed opens its local workspace database and does not import arbitrary SQLite databases. Restore only trusted backups. RustSec lists `libsqlite3-sys` 0.39.0 or later as patched for bundled SQLite. Recheck compatible upgrades and run workspace migration, restore, and native tests before changing the dependency stack. |
| RUSTSEC-2023-0071 (`rsa` Marvin timing attack)                                               | `rsa` 0.9.10                                                                 | No. Present only in `Cargo.lock` through `sqlx-mysql`; `cargo tree -i rsa` finds no path in the build graph | Not applicable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| RUSTSEC-2024-0429 (unsound `glib` 0.18.5)                                                    | `glib`                                                                       | Linux GTK build only                                                                                        | Not applicable to macOS and Windows beta targets. Recheck if a Linux build is added.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Unmaintained: `chrono`, `proc-macro-error`, `zbus_names`, `zvariant`, `zvariant_derive`      | transitive of Tauri, sqlx                                                    | Mostly Linux or build-time                                                                                  | No fix is available. Tracked by the upstream Tauri releases. Not a blocker.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

`cargo audit` result: 2 vulnerabilities found (the SQLite and `rsa` rows above), 6 warnings. Both vulnerabilities are dispositioned.

## Packages with no deprecation notice

`package-lock.json` marks no package as deprecated. Optional upgrades available (not applied, because upgrades are not part of this gate and each needs its own regression run): Tiptap 3.34, `@tauri-apps/api` 2.12.5, FullCalendar 7 (major), TypeScript 7 (major).

## Provenance and integrity

- Both lockfiles are committed. CI installs with `npm ci` and builds Rust with `--locked`, which fail on drift.
- Every registry fetch goes through the default npm registry and crates.io; all 379 lockfile entries resolve to `registry.npmjs.org` and `Cargo.lock` has no git sources.
- Actions use full commit SHAs with a version comment, and workflow tokens are read-only (see [CI](CI_CD.md)).

## Licenses

Production npm packages (109): 94 MIT, plus ISC, BSD-2/3-Clause, Apache-2.0 or MIT, and individually reviewed exceptions:

| Package                      | License                 | Note                                             |
| ---------------------------- | ----------------------- | ------------------------------------------------ |
| `@fontsource-variable/inter` | OFL-1.1                 | Font license; allows bundling and redistribution |
| `jszip` (via mammoth)        | MIT OR GPL-3.0-or-later | Use under MIT                                    |
| `pako` (via mammoth)         | MIT AND Zlib            | Permissive                                       |
| `argparse` (via mammoth)     | PSF-2.0                 | Permissive                                       |
| `duck` (via mammoth)         | BSD                     | Permissive                                       |

Cargo (332 crates): almost all MIT or Apache-2.0, with Unicode-3.0, Zlib, BSD-3-Clause, and Unlicense. Five crates are MPL-2.0 (`cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, `selectors`). MPL-2.0 is file-level copyleft: unmodified use needs no source release of the app. No GPL, AGPL, or LGPL dependency was found in either graph. The app's own crate has no `license` field; setting it and adding the `LICENSE` file is part of U2-P6-20.

## Changes since this audit

- U2-P6-15 added `rfd` 0.17.2 as a direct Cargo dependency (default features off) to show a native message when startup fails. It was already in the build graph through `tauri-plugin-dialog`, so no new crate was added to the lockfile.

## Reproducibility

Lockfiles, pinned Node (`.nvmrc`), pinned Rust (`rust-toolchain.toml`), and SHA-pinned actions make inputs reproducible. Byte-identical installers were not checked: Tauri bundles embed timestamps and platform signing data.

## Gaps and follow-ups

- No dedicated unused-dependency tool was run, so "unnecessary dependencies" was reviewed by reading `package.json` and `Cargo.toml` only; no unused entries were identified.
- Windows and Linux dependency graphs were not audited (`cargo audit` reads the whole lockfile, but the license table covers macOS arm64 only).
- The SQLite advisory is disclosed for beta. Recheck the locked dependency stack and patched upgrade options before each subsequent prerelease.
