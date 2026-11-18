# License, redistribution, and legal readiness

Review for U2-P6-20. **No software license has been chosen.** The repository has no `LICENSE` file, `package.json` and `Cargo.toml` declare no license, and nothing here picks one for the owner. Commit `main` after #246.

## Current status

- With no license, the code is **all rights reserved** to its authors by default. Others may not copy, modify, or redistribute it, even if the repository is made public. A public repository is not an open-source license.
- Until the owner selects and records a license, Unhollowed 2 must not be described as open source, and no redistribution terms can be promised beyond what the owner grants in writing.
- Dependencies are separate from this: each keeps its own license, listed in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Decision needed from the owner

Choose a license, and confirm the **copyright holder name and year** (a person or a company) for the notice. Then the follow-up is mechanical: add `LICENSE`, set the SPDX `license` field in `package.json` and `src-tauri/Cargo.toml`, set `bundle.copyright` in `tauri.conf.json`, update the README and installer notes, and regenerate the notices.

## Options

| Option                                                                                  | In short                                                                                            | Fits this project                                                            | Watch out for                                                                             |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **MIT**                                                                                 | Anyone may use, modify, and redistribute, including in closed-source products, if the notice stays. | Same family as most dependencies (94 of 109 npm packages are MIT). Simplest. | Others may build proprietary forks. No patent grant.                                      |
| **Apache-2.0**                                                                          | Permissive, plus an explicit patent license and a `NOTICE` mechanism.                               | Good if contributions from companies are expected.                           | A little more paperwork (state changes, keep notices).                                    |
| **MPL-2.0**                                                                             | Modified files must stay MPL and be shared; the rest may be combined with other code.               | Already used by five dependencies (`cssparser`, `selectors`, ...).           | Weak copyleft needs the owner to be comfortable with file-level sharing.                  |
| **GPL-3.0-or-later**                                                                    | Derivative works must be released under the GPL with source.                                        | Compatible with every dependency here (all permissive or MPL).               | Many closed-source and some app-store distributions become impossible for others.         |
| **AGPL-3.0-or-later**                                                                   | GPL plus a network-use clause.                                                                      | The clause has little effect on a local, offline app.                        | Same as GPL; strongest copyleft.                                                          |
| **Source-available or proprietary** (for example PolyForm, BSL, or all rights reserved) | The code can be read; use or redistribution is limited.                                             | Keeps full control.                                                          | **Not open source** by the Open Source Initiative definition and must not be called that. |

No dependency forces a choice. The production dependencies are MIT, ISC, BSD, Apache-2.0, Zlib, Unicode-3.0, OFL-1.1 (one bundled font), PSF-2.0, and MPL-2.0 (five crates, unmodified). `jszip` is offered as MIT or GPL-3.0 and is used under MIT. Details: [Dependencies](DEPENDENCIES.md).

## Third-party compliance

| Requirement                                                                          | Status                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| List every shipped dependency with its license                                       | Done: `THIRD_PARTY_NOTICES.md`, 469 packages (npm and Rust, macOS Apple Silicon and Windows x64), generated by `npm run notices` from the lockfiles.                                                                                                                                       |
| Include license texts where the license requires them (MIT, BSD, Apache-2.0 notices) | Done for every package that ships a license file: 259 distinct texts. **21 packages** declare a license but ship no license file, so no copyright line is available locally; they are listed in the notices. Before the first public beta, add their texts from each project's repository. |
| Provide the notices to users                                                         | **Open.** The file is in the repository. It is not yet bundled into the installers or shown in the app. Add it as a bundled resource, or link it from the release notes and installer page, before publishing.                                                                             |
| Fonts                                                                                | Inter is bundled under OFL-1.1 (`@fontsource-variable/inter`); the notices include its text.                                                                                                                                                                                               |
| MPL-2.0 crates                                                                       | Used unmodified. Source for them is available from their upstream repositories; keep that statement if one is added to the notices page.                                                                                                                                                   |
| Keep the notices current                                                             | Run `npm run notices` after any dependency change and commit the result. `npm run notices -- --check` fails when the file is stale. It needs `cargo fetch --locked --target x86_64-pc-windows-msvc` first. It is not part of Quick CI, so add it to the release checklist.                 |

## Redistribution terms (until a license exists)

The owner has not granted redistribution rights. Installers published as test builds should say so. When a license is chosen, that license is the redistribution term, and the notices file travels with every copy.

## Beta disclaimer (proposed wording for the README and release notes)

> Unhollowed 2 is beta software, provided as is, without warranty. It can have bugs that lose or damage data. Keep your own copies of anything important (see Backup). Features may change before 1.0. Unsigned test builds are not for general distribution.

Use the license's own warranty disclaimer once one is chosen.

## Supported platforms

| Platform                              | Support level | Evidence                                                                                                                                                                                               |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS, Apple Silicon (arm64)          | Beta target   | Built and run on macOS 26.5.1; install, upgrade, relaunch, uninstall checked ([macOS](MACOS_DISTRIBUTION.md)). The minimum macOS version is untested; Tauri's default of 10.13 is probably too low.    |
| Windows 10/11, x64                    | Beta target   | NSIS and MSI installers installed and run on a real Windows Server 2025 x64 runner ([Windows](WINDOWS_DISTRIBUTION.md)). Not yet run on Windows 10 or a Windows 11 client. Needs the WebView2 runtime. |
| macOS on Intel, Windows on ARM, Linux | Not supported | Not built or tested for release.                                                                                                                                                                       |

## Attribution

`THIRD_PARTY_NOTICES.md` is the attribution. The Unhollowed name and butterfly mark are the owner's; no license text here grants rights to them, and the owner should state a trademark position when the license is chosen.

## Not done

- Selecting or adding a license, or any legal advice. This document organizes the decision; it is not legal advice.
- Reviewing the licenses of design assets and the font beyond what the package metadata states.
