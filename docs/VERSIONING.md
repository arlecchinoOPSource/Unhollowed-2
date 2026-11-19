# Release versioning

Versioning policy for U2-P6-16 and the `1.0.0-beta.1` release candidate.

## Where the version lives

All six must match exactly. `tests/unit/versions.test.tsx` fails the build when they differ or when the value is not valid SemVer.

| File                        | Field                                                                     |
| --------------------------- | ------------------------------------------------------------------------- |
| `package.json`              | `version`                                                                 |
| `package-lock.json`         | `version` and `packages[""].version`                                      |
| `src-tauri/Cargo.toml`      | `[package] version`                                                       |
| `src-tauri/Cargo.lock`      | the `unhollowed-2` package `version`                                      |
| `src-tauri/tauri.conf.json` | `version` (shown to the operating system and in installer names)          |
| `CHANGELOG.md`              | A dated `## <version>` heading replaces `## Unreleased` in the release PR |

The application's own metadata (window title, bundle name) comes from `tauri.conf.json` and `Cargo.toml`; the app does not hard-code a version string anywhere else.

## Version for the first beta

`1.0.0-beta.1` (SemVer 2.0). npm, Cargo, and Tauri all accept it. The candidate sets the application version in all six places and WiX ProductVersion to `0.99.1`. The tag follows from the reviewed commit after authorization.

## Increment rules

| Change                                | From           | To             |
| ------------------------------------- | -------------- | -------------- |
| Next beta                             | `1.0.0-beta.1` | `1.0.0-beta.2` |
| Candidate after the betas             | `1.0.0-beta.N` | `1.0.0-rc.1`   |
| Final release                         | `1.0.0-rc.N`   | `1.0.0`        |
| Bug-fix release                       | `1.0.0`        | `1.0.1`        |
| New backward-compatible features      | `1.0.1`        | `1.1.0`        |
| Breaking change or data-format change | `1.1.0`        | `2.0.0`        |

SemVer orders prerelease parts field by field, numbers numerically: `1.0.0-beta.2` < `1.0.0-beta.10` < `1.0.0-rc.1` < `1.0.0`. Every published build gets a new version, never a reused one. A database migration is added in the same release that needs it and never edited afterwards (see [Data model](DATA_MODEL.md)); the app refuses a database from a newer version rather than changing it.

## Windows installers: a constraint found by a real build

Windows packaging was tested on a throwaway branch with the CI workflow (`Desktop packaging`, Windows x64 runner, unsigned, no tag, no release). The branch was deleted afterwards.

| Setting                                                                 | Result                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App version `1.0.0-beta.1`, no other change                             | **The MSI build fails**: `optional pre-release identifier in app version must be numeric-only and cannot be greater than 65535 for msi target`. The NSIS setup `.exe` built. |
| App version `1.0.0-beta.1` plus `bundle.windows.wix.version = "0.99.1"` | **Both installers build** (NSIS `.exe` and MSI), named with the app version, `Unhollowed 2_1.0.0-beta.1_x64-setup.exe` and `Unhollowed 2_1.0.0-beta.1_x64_en-US.msi`.        |

The candidate uses the explicit MSI version from the successful packaging trial.

### How Windows Installer compares versions

The MSI version is `major.minor.build` with maximums 255, 255, and 65535. Windows Installer ignores a fourth field when deciding whether one version upgrades another, so a scheme such as `1.0.0.N` would not upgrade from beta to beta. The MSI version must increase in its first three fields, and the final `1.0.0` must be higher than every beta, or users could not upgrade from a beta to the final release.

### Recommended MSI version mapping

| App version       | `bundle.windows.wix.version`           |
| ----------------- | -------------------------------------- |
| `1.0.0-beta.N`    | `0.99.N`                               |
| `1.0.0-rc.N`      | `0.99.(100 + N)`                       |
| `1.0.0` and later | omit the field (Tauri derives `1.0.0`) |

Remove or update the `wix.version` line in the release PR that publishes `1.0.0`. The mapping is monotonic: `0.99.1` < `0.99.2` < `0.99.101` < `1.0.0`. The NSIS installer uses the full SemVer string and needs no mapping.

Not verified: that Windows Installer actually upgrades `0.99.1` to `0.99.2` in place (needs a Windows machine and two builds); the product version stored inside the built MSI was not read back (the file name uses the app version); and the unsigned installers were not run. Record those in U2-P6-18.

## Release PR checklist

1. Set the version in all six places and add the dated changelog heading.
2. Add `bundle.windows.wix.version` per the table for a prerelease.
3. Run `npm run test:mac`, then **Desktop packaging → both** from the reviewed commit.
4. Verify the installer names and versions, then follow [Release](RELEASE.md) for tagging.

## Status

The version guard checks the candidate metadata. Verify its actual installers before publishing.
