# macOS Apple Silicon distribution

Validation and plan for U2-P6-17. Local checks were run on macOS 26.5.1, Apple M5, on a release build of this change (`npx tauri build --bundles app`). **No signing credential exists on this machine or in the repository, none was created, and nothing here is signed or notarized.**

## Two kinds of build

| Kind                         | Made by                                                               | Signed                                     | Who can run it                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsigned internal test build | `Desktop packaging` workflow (`--no-sign`) or `npm run desktop:build` | Ad-hoc only                                | Developers and testers. After a download, macOS quarantines it and Gatekeeper blocks it until the tester opens it with right-click, **Open**, or clears the flag with `xattr -dr com.apple.quarantine "Unhollowed 2.app"`. Never give this build to the public. |
| Notarized public build       | A future release job with Apple credentials (see below)               | Developer ID Application, hardened runtime | Anyone; opens with the normal Gatekeeper prompt.                                                                                                                                                                                                                |

## What was verified on the unsigned build

| Item                                         | Result                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production app build                         | Pass. `Unhollowed 2.app`, 25 MiB.                                                                                                                                                                                                                                                                                                                  |
| Architecture                                 | `arm64` only (`lipo -archs`). Intel Macs are not supported, which matches the Apple Silicon scope.                                                                                                                                                                                                                                                 |
| Bundle metadata                              | `CFBundleIdentifier` `dev.arlecchino.unhollowed2`, `CFBundleDisplayName` `Unhollowed 2`, `CFBundleShortVersionString` and `CFBundleVersion` `0.1.0` (the release PR sets the real version, see [Versioning](VERSIONING.md)), `LSApplicationCategoryType` `public.app-category.productivity` (**added in this change**).                            |
| Application icon                             | **Fixed in this change.** The bundle's `.icns` held only 256 and 512 px images, so Finder lists and the Dock at small sizes used scaled artwork. It is now generated from the 1024 px brand source (`public/favicon.svg`) with `tauri icon`, with all 10 sizes from 16 px to 512@2x. The artwork is unchanged (compared by eye).                   |
| Clean installation                           | Pass. The app was copied into an empty Applications folder and started with an empty home folder; it created `workspace.sqlite3` and applied all 29 migrations.                                                                                                                                                                                    |
| Relaunch and persistence                     | Pass. After quitting and relaunching, the migration count (29) and all rows were unchanged.                                                                                                                                                                                                                                                        |
| Upgrade over older data                      | Pass. A database written by an older release (migrations 1 to 5, one project, one issue; made by `backup_tests::write_older_release_fixture`) was upgraded by the new build to migration 29 with the project and issue intact and `integrity_check` `ok`.                                                                                          |
| Uninstall behavior                           | The app was removed from the Applications folder. The data folder (`workspace.sqlite3` and its `-wal` and `-shm` files in `~/Library/Application Support/dev.arlecchino.unhollowed2/`) stayed. Dragging the app to the Trash does not remove user data, so a reinstall finds the same workspace. To remove everything, delete that folder by hand. |
| Gatekeeper                                   | The unsigned bundle is **not acceptable**: `codesign -dv` shows an ad-hoc linker signature with no sealed resources, and `spctl -a -vv` reports `code has no resources but signature indicates they must be present`. Expected for an unsigned build; a Developer ID signature fixes it.                                                           |
| Developer ID signing, notarization, stapling | **Not done.** No credentials. See the procedure below.                                                                                                                                                                                                                                                                                             |

All app launches in these checks used a throwaway `HOME` folder, so no real workspace was opened. To repeat the upgrade check: `U2_OLD_DATABASE=/tmp/old/workspace.sqlite3 cargo test write_older_release_fixture -- --ignored` (in `src-tauri`), put the file in `~/Library/Application Support/dev.arlecchino.unhollowed2/` of a throwaway `HOME`, and launch the app with that `HOME`.

### Not verified

- The DMG. The packaging workflow (`Desktop packaging`, macOS) was dispatched on `main` for this check, but its macOS runner had not started when this was written, so no CI-built DMG was inspected here. Run it from the Actions tab, download the artifact, mount it, and confirm it holds the app and an Applications shortcut. Record the result in the release checklist (U2-P6-19).
- Launching from a quarantined download, or from the DMG on a clean machine.
- The `LSMinimumSystemVersion` of `10.13` that Tauri writes by default. It is probably lower than the real minimum, because Tauri 2 documents macOS 10.15 and the web view features the app needs were not checked on older systems. **Owner decision:** set `bundle.macOS.minimumSystemVersion` to a tested value before release. Only macOS 26.5.1 was tested here.
- A copyright line (`bundle.copyright`). The holder and year are the owner's to choose and were not invented.

## Apple Developer Program steps for a notarized build

These are the steps for the owner. Nothing below was run.

1. **Enroll** in the Apple Developer Program as an individual or an organization (annual fee). Note the Team ID.
2. **Create a Developer ID Application certificate** (Certificates, Identifiers & Profiles, or Xcode), export it with its private key as a `.p12` file with a strong password. Keep it out of the repository.
3. **Choose how to notarize.** Either an app-specific password for the Apple ID, or an App Store Connect API key (issuer ID, key ID, `.p8` file). The API key is preferred for CI.
4. **Store the secrets** in a protected GitHub environment that only release jobs can use: the base64 of the `.p12`, its password, the signing identity (`Developer ID Application: <Name> (<TEAMID>)`), and either the Apple ID, app-specific password, and Team ID, or the API key values. Tauri reads them as `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and either `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` or `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`.
5. **Build with signing on** (the current workflow passes `--no-sign`). Tauri signs the app with the hardened runtime and submits it for notarization when those variables are present. No special entitlements are expected for a WebKit-based app that makes no network calls; add one only if a signed build fails to launch, and name the reason.
6. **Verify** the result on a machine without the certificate:

```sh
codesign --verify --deep --strict --verbose=2 "Unhollowed 2.app"
spctl -a -vvv -t exec "Unhollowed 2.app"
xcrun stapler validate "Unhollowed 2.app"
```

7. **Notarize and staple the DMG** too (`xcrun notarytool submit <dmg> --wait`, then `xcrun stapler staple <dmg>`), then `spctl -a -vvv -t install <dmg>`. Download the final DMG through a browser on a clean machine and open it to confirm the normal Gatekeeper prompt.
8. **Keep the identifier.** Signing and notarization tie to the bundle identifier; do not change it after release ([Identity](IDENTITY.md)).

Add the signed job in U2-P6-19, separate from the unsigned validation workflow, so that only an authorized release run can use the secrets.

## Findings

| ID    | Severity              | Finding                                                                  | Status                                                                               |
| ----- | --------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| MAC-1 | Medium                | The `.icns` held only two sizes.                                         | Fixed here.                                                                          |
| MAC-2 | High (public release) | No Developer ID signature or notarization; Gatekeeper rejects the build. | Open. Needs the owner's Apple Developer account. Not a blocker for internal testing. |
| MAC-3 | Low                   | Declared minimum macOS (10.13) is untested and probably too low.         | Open. Owner decision.                                                                |
| MAC-4 | Low                   | No copyright line in the bundle metadata.                                | Open. Owner decision.                                                                |
| MAC-5 | Info                  | CI DMG not inspected (runner queued).                                    | Open.                                                                                |
