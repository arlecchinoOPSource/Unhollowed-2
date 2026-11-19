# Privacy statement (beta)

This is the user-facing statement. Every claim is backed by a check recorded in [Privacy verification](PRIVACY.md), [Security](SECURITY.md), and [Recovery](RECOVERY.md); where something was not verified, it says so.

## In short

Unhollowed 2 is a local app. Your projects, issues, documents, calendar, habits, and mood check-ins stay on your computer. The app has no account, no sync, and no analytics. Its only network request is an update check, made only when you ask for one.

## What the app does not do

- **No account or sign-in.** Nothing asks for an email or password.
- **No telemetry or analytics.** No usage, crash, or content data is collected or sent. The app contains no code for it, and its dependencies include no analytics or error-reporting package (checked in source on every test run).
- **No uploads.** Documents and records leave the app only when you export or print them, to the place you choose.
- **No remote content.** The interface, fonts, and icons are all bundled with the app. It works offline.
- **No logs of your content.** The app writes no log file. Errors it prints are fixed sentences plus a technical error code, not your text.

## What is stored on your computer, and where

| What                                                 | Where                                                                                                                                                                                      | Encrypted |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| All your records and uploaded images                 | One database file, `workspace.sqlite3`, in the app's data folder: `~/Library/Application Support/dev.arlecchino.unhollowed2/` on macOS, `%APPDATA%\dev.arlecchino.unhollowed2\` on Windows | **No**    |
| Text you are typing in a document, until it is saved | The app's web view storage, so it can be offered back after a crash                                                                                                                        | **No**    |
| Appearance and view preferences                      | The same web view storage                                                                                                                                                                  | **No**    |
| Copies the app makes before a habit restore          | A `habit-copies` folder in the data folder                                                                                                                                                 | **No**    |
| Files you export                                     | Wherever you save them                                                                                                                                                                     | **No**    |

## Security limitations

- **Nothing is encrypted.** The data is protected only by your operating system's account and disk protections. Anyone who can read your user files, or your unlocked computer, can read your workspace. On the macOS development install the database file is readable by other accounts on the same Mac (mode `0644`), though the folder is inside your home. Use full-disk encryption (FileVault, BitLocker) for real protection. Do not describe this data as secure against someone with access to your device.
- **Backups are manual.** There is no in-app full backup. To copy your workspace, quit the app and copy the whole data folder, including the `-wal` and `-shm` files if present ([Backup](BACKUP.md)).
- **Removing the app does not remove your data.** Delete the data folder yourself to erase it.
- **Files you open are handled locally** with size limits and checks, but you should open files only from sources you trust.
- **Verified so far:** source and dependency checks on every build, and the browser build with network access blocked. **Not verified yet:** the packaged app run with the machine offline or under a network monitor, and the operating system's web view components (WebKit on macOS, WebView2 on Windows), which are not part of the app and may have their own behavior.

## Your control

You own your data. You can export projects (JSON), issues (CSV), calendar events (ICS), habits (JSON), and documents (several formats), and you can delete everything by removing the data folder.

## Changes and contact

This statement describes the beta. It will be updated if the app ever adds a network feature, and any such feature will be off by default and described here first.

**Update check.** When you choose to check for updates, the app downloads one small file from the project's GitHub releases over HTTPS. The request contains no workspace data, account, or app version. GitHub, like any web server, sees your IP address and the request time. The app never checks on its own. Contact details are the owner's to add.
