# Release preparation

Use SemVer and version tags such as `v1.0.0-beta.1`. Update the npm manifest and lockfile, Rust manifest and lockfile, Tauri configuration, and changelog in one release PR. For Windows MSI, confirm that the numeric version fits Windows Installer constraints and increases across installer upgrades.

1. Review the release PR and verify Quick CI and local macOS full checks.
2. Validate the candidate from a reviewed ref using **Desktop packaging → both**. When authorized, push the version tag from the reviewed commit to build both platform packages again.
3. Download the artifacts for that exact commit. Install the Windows x64 NSIS and MSI packages on clean Windows test machines and verify WebView2 startup, local storage, upgrades, and uninstall. On Apple Silicon, mount the DMG, install the app, and check startup, local storage, and upgrades.
4. Produce distribution packages with separately managed signing credentials. Sign Windows installers and binaries with a trusted certificate and verify them with SignTool. For direct macOS distribution, use Developer ID signing, notarize and staple, then verify code signing and Gatekeeper acceptance. The validation workflow creates unsigned artifacts for testing.
5. Once explicitly authorized, a maintainer creates a draft GitHub Release from the tag, uploads the verified distribution installers and SHA-256 checksums, and reviews the notes and assets. Mark beta versions as prereleases before publishing.

The current workflows upload temporary validation artifacts. There is no release publication job or automatic updater. See [Tauri distribution](https://v2.tauri.app/distribute/) for installer and signing procedures.
