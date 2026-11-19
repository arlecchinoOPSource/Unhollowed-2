# Windows x64 distribution

Validation and plan for U2-P6-18. The installers were built and **run on a real Windows machine**: a GitHub-hosted `windows-2025` runner (Windows Server 2025, x64, with WebView2 runtime 156.0.4314.58), using the `Windows installer test` workflow and `scripts/windows-install-test.ps1`. Commit `main` after #244 plus this change; app version `0.1.0`. A successful cross-build alone is not treated as proof; the table below is from the runs. **No code-signing certificate exists, none was created, and nothing is signed.**

## Results from the real Windows runs

Three runs were made while fixing the test script itself (the last two pass every check). Final run, all checks passed:

| Check                               | Result           | Detail                                                                                                                 |
| ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| WebView2 runtime present            | Pass             | Version 156.0.4314.58 (preinstalled on the runner).                                                                    |
| Installer signatures                | Both `NotSigned` | Expected: unsigned validation builds.                                                                                  |
| NSIS: silent install (`/S`)         | Pass             | Per-user, `%LOCALAPPDATA%\Unhollowed 2\unhollowed-2.exe`.                                                              |
| NSIS: first start                   | Pass             | Main window about 0.55 s after launch; 6 WebView2 processes started; the workspace was created with all 29 migrations. |
| NSIS: relaunch                      | Pass             | Same 29 migrations, nothing re-applied.                                                                                |
| NSIS: upgrade of an older workspace | Pass             | A database from migration 5 (one project, one issue) went to 29 with the project kept and `integrity_check` `ok`.      |
| NSIS: uninstall (`/S`)              | Pass             | The app was removed; `workspace.sqlite3` stayed in `%APPDATA%\dev.arlecchino.unhollowed2\`.                            |
| MSI: silent install (`msiexec /qn`) | Pass             | Registered `ProductVersion` `0.1.0`; also per-user, in `%LOCALAPPDATA%\Unhollowed 2`.                                  |
| MSI: first start                    | Pass             | Window about 0.53 s, 6 WebView2 processes, 29 migrations.                                                              |
| MSI: uninstall (`msiexec /x`)       | Pass             | App removed; workspace database kept.                                                                                  |

### Product metadata as Windows shows it (Apps and features)

| Field     | NSIS entry                                        | MSI entry                      |
| --------- | ------------------------------------------------- | ------------------------------ |
| Name      | `Unhollowed 2`                                    | `Unhollowed 2`                 |
| Version   | `0.1.0`                                           | `0.1.0`                        |
| Publisher | `arlecchino` (derived from the bundle identifier) | `arlecchino`                   |
| Icon      | The app executable's icon                         | **Empty**: no icon in the list |

The executable's icon file is complete (`icon.ico` has 16, 24, 32, 48, 64, and 256 px images). The publisher is lowercase because Tauri takes it from the identifier `dev.arlecchino.unhollowed2`; set `bundle.publisher` to the display name the owner wants. That is an owner choice and was not invented.

## Findings

| ID    | Severity              | Finding                                                                                                                                                                                                                                                                                | Status                                                                                                                                                                      |
| ----- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WIN-1 | High (public release) | Installers are unsigned, so Windows SmartScreen warns on download and run, and Windows 11 Smart App Control may block them.                                                                                                                                                            | Owner-approved limitation for the first public beta. Verify and disclose blocks on the candidate. Signing remains follow-up work.                                           |
| WIN-2 | Medium                | The default `webviewInstallMode` downloads the WebView2 bootstrapper when the runtime is missing, so a first install on a PC without WebView2 and without internet fails. Windows 11 and current Windows 10 normally have the runtime. The app itself is fully offline once installed. | Open. Owner decision: keep the default, embed the bootstrapper (small, still needs internet), or ship `offlineInstaller` (about 130 MB larger, works offline). Not changed. |
| WIN-3 | Medium                | NSIS and MSI both install per-user into the same folder, `%LOCALAPPDATA%\Unhollowed 2`. Installing both on one PC would conflict.                                                                                                                                                      | Open. Publish the NSIS setup as the main installer; offer the MSI only for managed deployment, and say not to mix them.                                                     |
| WIN-4 | Low                   | Publisher shows as `arlecchino` and the MSI entry has no icon.                                                                                                                                                                                                                         | Open. Set `bundle.publisher` (owner's name); the MSI icon is a cosmetic gap.                                                                                                |
| WIN-5 | Low                   | The first beta needs an explicit MSI version ([Versioning](VERSIONING.md)); with `1.0.0-beta.1` the MSI build fails.                                                                                                                                                                   | Open for the release PR.                                                                                                                                                    |

## Signing and SmartScreen (plan; nothing run)

1. **Get a code-signing certificate** for the publisher name. Options: a certificate from a public certificate authority, or Microsoft's Azure Trusted Signing. A certificate on a hardware token or a cloud service cannot be exported, so the build must use a signing command (`bundle.windows.signCommand`) or the service's GitHub action. Keep the secrets in a protected GitHub environment used only by release jobs.
2. **Sign** both the installers and the application executable, with an RFC 3161 timestamp so signatures outlive the certificate.
3. **Verify**:

```powershell
signtool verify /pa /v "Unhollowed 2_<version>_x64-setup.exe"
Get-AuthenticodeSignature "Unhollowed 2_<version>_x64-setup.exe" | Format-List Status, SignerCertificate
```

The workflow already records `Get-AuthenticodeSignature` for both installers, so a signed run shows `Valid`.

4. **SmartScreen limitations**: even a signed installer can show "Windows protected your PC" until the file builds reputation with Microsoft. Signing makes the publisher visible and is required for reputation to attach to it. An extended-validation certificate no longer gives instant reputation. For internal testers on an unsigned build: **More info**, then **Run anyway**. Publish SHA-256 checksums next to the installers (U2-P6-19).

## Not verified

- A **signed** installer, SmartScreen and Smart App Control behavior (no certificate, and the runner does not show interactive prompts).
- An installer **over** an older installer (in-place NSIS or MSI upgrade). What was verified is an older **workspace** upgraded by the new app. Check an MSI upgrade from the beta MSI version to the next once two builds exist ([Versioning](VERSIONING.md)).
- Windows 10, Windows 11 client, and ARM64. The runner is Windows Server 2025 x64.
- A machine without WebView2, an offline install, a per-machine install (the MSI installed per-user), and a repair or modify run.
- The visual appearance of the window and the real icon in Explorer and the taskbar. The checks confirm that a window and WebView2 processes exist, not what is drawn.

## Repeating the test

Run the **Windows installer test** workflow from the Actions tab (manual only). It builds the unsigned installers, writes an older-release database fixture with `cargo test write_older_release_fixture -- --ignored`, and runs `scripts/windows-install-test.ps1`, publishing the table above to the job summary. The script can also be run by hand on a **disposable** Windows machine: it deletes `%APPDATA%\dev.arlecchino.unhollowed2`.
