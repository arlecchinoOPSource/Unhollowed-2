# Unhollowed 2 user guide (beta)

Unhollowed 2 is a free, local-first desktop workspace by Arlecchino that keeps your documents, projects and issues, calendar, habits, mood check-ins, and dashboards in one place. It works offline, needs no account, and stores everything on your computer. This is beta software: it can have bugs, so keep your own backups ([Backup and recovery](#backup-and-recovery)).

## What you can do

- **Home and Today**: what is overdue, due today, scheduled, and recent, with quick actions.
- **Projects and issues**: projects with goals, issues with priority, dates, labels, milestones, relationships, repeats, a list and a board, saved views, and search.
- **Documents**: a rich-text editor (headings, lists, tables, images, fonts, page layout), folders, templates, links between documents, a graph of those links, version history, and print.
- **Calendar**: day, week, work week, month, and agenda views; events, repeating events, work sessions for issues, deadlines, reminders, and time zones.
- **Habits and mood**: a habit grid and history, daily check-ins for mood, energy, and focus, and trends.
- **Dashboards**: charts and totals you arrange yourself.
- **Appearance**: light and dark themes.

Not in this beta: accounts, sync between computers, mobile apps, an in-app full backup, and automatic updates.

## Supported systems

| System                               | Status                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS on Apple Silicon (M1 or later) | Supported for the beta. Tested on macOS 26.5.1. Older macOS versions are untested.                                                                                                  |
| Windows 10 or 11, 64-bit (x64)       | Supported for the beta. Installers were tested on a Windows Server 2025 machine, not yet on a Windows 10 or 11 PC. Needs the Microsoft WebView2 runtime, which Windows 11 includes. |
| Intel Macs, Windows on ARM, Linux    | Not supported.                                                                                                                                                                      |

## Install

The beta installers are **not signed or notarized**, so your computer will warn you. Only install files you got from the project owner, and check them first (below).

1. **Check the download.** Compare its SHA-256 with `SHA256SUMS` from the same release: `shasum -a 256 -c SHA256SUMS` on macOS, or `Get-FileHash <file>` in PowerShell on Windows.
2. **macOS.** Open the `.dmg`, drag **Unhollowed 2** to Applications. The first time, right-click the app, choose **Open**, then **Open** again. If macOS still refuses, run `xattr -dr com.apple.quarantine "/Applications/Unhollowed 2.app"` in Terminal.
3. **Windows.** Run `Unhollowed 2_..._x64-setup.exe`. If SmartScreen says "Windows protected your PC", choose **More info**, then **Run anyway**. It installs for your account only. The `.msi` is for managed deployment; install only one of the two, not both.

Installing needs no internet if WebView2 is already present. If Windows asks to download WebView2, you need a connection once.

## Get started

1. Open Unhollowed 2. It creates an empty workspace on first launch.
2. On **Home**, use the **Quick actions** to add an issue, start a document, or add an event.
3. Create a project under **Projects**, add issues to it, and open **Calendar** to plan work.
4. Try **Habits** and **Mood** for daily routines, and **Dashboards** to see how things are going.

Everything saves as you work. A document saves a moment after you stop typing, and the editor shows **All changes saved**. If it shows **Could not save**, keep the window open, free some disk space or retry, and your text stays on screen.

## Where your data is stored

Everything is in one folder on your computer. It is not encrypted and not uploaded anywhere.

| System  | Folder                                                      |
| ------- | ----------------------------------------------------------- |
| macOS   | `~/Library/Application Support/dev.arlecchino.unhollowed2/` |
| Windows | `%APPDATA%\dev.arlecchino.unhollowed2\`                     |

The main file is `workspace.sqlite3`; next to it you may see `workspace.sqlite3-wal` and `workspace.sqlite3-shm`, which are part of the same database. Text you are still typing is also kept briefly in the app's web view storage so it can be offered back after a crash. Removing the app does **not** remove this folder. See the [privacy statement](PRIVACY_STATEMENT.md).

## Import and export

| What                              | How                                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects and issues (JSON)        | **Settings → Data**: export, or import an export as copies after a preview.                                                                                                      |
| Issue list (CSV)                  | **Export CSV** on an issue list; saves what your filters match.                                                                                                                  |
| Calendar (ICS)                    | Import and export on the calendar. A file larger than 5 MiB is refused.                                                                                                          |
| Habits (JSON backup, CSV history) | In **Habits**. A restore replaces your habits only, after a preview and a private copy.                                                                                          |
| Documents                         | In the editor: export to Word (.docx), Markdown, text, HTML, or an Unhollowed file (.u2doc); import Word, Markdown, text, or .u2doc. Print or save as PDF from the print dialog. |

A file that cannot be read is rejected as a whole with a reason, and nothing in your workspace changes. Word import keeps text, headings, lists, tables, links, images, and page layout, but **not** paragraph alignment, fonts, sizes, or page breaks.

## Backup and recovery

There is **no in-app full backup yet.** To back up everything:

1. Quit Unhollowed 2 completely.
2. Copy the whole data folder (above), including the `-wal` and `-shm` files if they exist, to a safe place.

To restore: quit the app, keep a copy of the current folder, delete `workspace.sqlite3-wal` and `workspace.sqlite3-shm` from it, and put the backup's `workspace.sqlite3` (and its `-wal` and `-shm`, if you copied them) in their place. Restoring replaces the whole workspace. Do not copy the folder while the app is running, and copy only `workspace.sqlite3` after a crash at your own risk: the newest changes may be in the `-wal` file. Details: [Backup](BACKUP.md), [Recovery](RECOVERY.md).

## Update to a newer beta

There is no automatic updater. Download the newer installer from the owner, verify it, **back up first**, quit the app, and run the installer. Your data folder is separate from the app and is kept, and a newer app upgrades an older workspace on first start. Installing one installer over another was not tested yet. An older app **refuses** a workspace written by a newer one and shows a message; install the newer version instead.

## Known limitations

- Beta software, provided as is, without warranty; it can lose or damage data.
- No full in-app backup; backups are manual.
- Installers are unsigned; expect macOS and Windows warnings.
- Word import drops alignment, fonts, sizes, and page breaks.
- No accounts, sync, or mobile apps; one workspace per computer.
- Nothing is encrypted; protect your files with FileVault or BitLocker.
- Tested on a limited set of systems (see above); accessibility was checked with automated tools, not with screen readers.
- No open-source license has been chosen yet ([Legal](LEGAL.md)).

## Troubleshooting

| Problem                                                                      | What to try                                                                                                                         |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| macOS says the app "cannot be opened" or is from an unidentified developer   | Right-click the app, **Open**; or clear quarantine with the `xattr` command above.                                                  |
| Windows shows "Windows protected your PC"                                    | **More info**, then **Run anyway**, for a file you verified.                                                                        |
| The app shows "This workspace was last opened by a newer version" and closes | You opened a newer workspace with an older app. Install the newer version. Your data was not changed.                               |
| "Unhollowed 2 could not open your workspace"                                 | Restart. If it persists, restore a backup. Do not delete the data folder.                                                           |
| A page shows "Something went wrong on this page"                             | Choose **Try again**, or **Go to Home**. Saved work is not affected.                                                                |
| Windows asks to download WebView2                                            | Connect to the internet once, or install the WebView2 runtime separately.                                                           |
| "Could not save" in a document                                               | Keep editing in the window, make sure the disk has space, and wait for a retry. Your text is kept and offered back after a restart. |
| An import is rejected                                                        | Read the reason shown. The file is too large, unreadable, or not the expected format; nothing was changed.                          |

## Report a problem

Open an issue at <https://github.com/arlecchinoOPSource/Unhollowed-2/issues> using the **Bug report** form. Include the app version, your operating system, and steps to reproduce using **sample data**. Do not include personal information, your database, or documents you do not want shared.
