# License, redistribution, and legal readiness

Unhollowed 2 is distributed under the [MIT License](../LICENSE), copyright © 2026 Arlecchino. Installer metadata lists Arlecchino as the publisher. Keep the copyright and permission notices with copies or substantial portions of the software.

## Third-party notices

Dependencies retain their own licenses. The application bundle includes [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) alongside the project license. Keep both files when redistributing the app. The notices identify dependency versions, license texts, and upstream source links. Inter ships under OFL-1.1. MPL-2.0 dependencies are used unmodified and their source is available from the upstream links.

Regenerate the notices after dependency changes with `npm run notices` and verify them with `npm run notices -- --check`. Fetch the locked Windows crates with `cargo fetch --locked --target x86_64-pc-windows-msvc` if they are missing locally.

## Privacy and beta status

See the [privacy statement](PRIVACY_STATEMENT.md) for local data and backup locations, storage limits, and what happens when you open an external link. Unhollowed 2 is beta software provided as is, without warranty. Keep [backups](BACKUP.md) of important work. Use unsigned validation builds for internal testing.

## Supported platforms

| Platform                              | Support level | Evidence                                                                                                                                                                                               |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS, Apple Silicon (arm64)          | Beta target   | Built and run on macOS 26.5.1; install, upgrade, relaunch, uninstall checked ([macOS](MACOS_DISTRIBUTION.md)). The minimum macOS version is untested; Tauri's default of 10.13 is probably too low.    |
| Windows 10/11, x64                    | Beta target   | NSIS and MSI installers installed and run on a real Windows Server 2025 x64 runner ([Windows](WINDOWS_DISTRIBUTION.md)). Not yet run on Windows 10 or a Windows 11 client. Needs the WebView2 runtime. |
| macOS on Intel, Windows on ARM, Linux | Not supported | Not built or tested for release.                                                                                                                                                                       |

## Attribution

The [third-party notices](../THIRD_PARTY_NOTICES.md) provide dependency attribution. Arlecchino owns the Unhollowed name and butterfly mark. The source license does not grant trademark rights.
