# Changelog

## Unreleased

- Added calendar management: create, rename, recolor, and describe calendars, show or hide them, choose the default, and archive or restore them while keeping their events. Archiving the default asks for a replacement, and events can move between calendars without changing identity.
- Added the scheduling data model: calendars with one default per workspace, timed and all-day events, issue work blocks, and issue deadlines projected without copies. Timed items keep their IANA zone and wall-clock intent alongside UTC instants, with documented half-open ranges and daylight-saving rules, and range reads use indexes. Adds migration 20.
- Improved accessibility and polish from a measured audit: light-mode accent text now meets 4.5:1 contrast, form fields have 3:1 borders in both themes, the description editor, date fields, and search field show focus, the board no longer widens the page, workspace search reaches "See all" with the arrow keys, and library animations honor reduced motion. Added automated WCAG checks for every page and open panel in light and dark mode, and repeatable backend and rendering timings recorded in `docs/PERFORMANCE.md`.
- Added data portability: export every project and issue, including archived ones, to a versioned JSON file from Settings, import such a file as copies after a preview that reports new issue keys and reused labels, with validation that rejects the whole file on unsupported versions, unknown fields, or broken references, and CSV export of the issues the current filters match, with formula-safe quoting. Files are saved with the native Save dialog from Rust, so the window still has no plugin permissions.
- Added issue archiving and restoring that keep status and every link, archived issues hidden by default with Hide, Include, and Only archived filters, and permanent deletion of archived issues only after an impact check, sub-issue and active-series blockers, and typing the issue key. Archiving a project keeps its issues. Adds migration 14.
- Added workspace-wide search from the header (⌘K or Ctrl+K) across projects, issues, and milestones, with grouped and capped results, issue-number jumps, keyboard navigation, and protection against stale results.
- Added progress rollups: objectives count their linked issues and sub-issues once each, missions roll up their objectives' issues without double counting, and objectives, missions, and milestones report blocked and canceled work alongside done ÷ non-canceled progress.
- Added a project overview: completion that excludes canceled issues, open and closed totals, issues by status, overdue and coming-up work by local date, milestone progress, and recent activity labeled by its timestamps. Each number links to the matching issue list.
- Added links from issues and projects to existing documents, with direct and issue-inherited project links shown separately, document pages that open from links and list what links to them, and unlinking that never changes the document. Adds migration 13.
- Added saved issue views: save list or board filters under a name, open them from the sidebar, update, rename, or delete them, and see when a view refers to a project, label, or milestone that no longer exists. Configurations are versioned, and due rules stay relative. Adds migration 12.
- Added recurring issues: daily, weekly, and monthly repeats every 1 to 99 units, anchored on the due date with month-end clamping. Completing or canceling an occurrence creates the next one atomically and only once, skipping missed dates. Repeats can be edited and stopped from the issue page. Adds migration 11.
- Replaced the Calendar placeholder with an issue calendar: a keyboard-navigable month grid of issues by due date, a project filter, drag or typed rescheduling, and creating an issue on a chosen day.
- Added Today and Upcoming views of open issues by local due date, with overdue issues in Today, date or project grouping, quick completion, rescheduling through `set_issue_due_date`, and refresh at local midnight or when the app resumes.
- Added a kanban board for All Issues and each project, with one column per status, the shared issue filters, drag-and-drop and keyboard Move menus, optimistic moves that roll back on failure, and paged columns for large boards.
- Added optional project missions and objectives, issue links, and individual objective progress.
- Added sub-issues, blocking dependencies, and related issues with cycle checks.
- Added keyboard shortcuts for issue capture, search, and traversal.

- Added workspace and project milestones with due dates, close and reopen, a milestones overview with live open, completed, and canceled counts and progress, milestone assignment on issues that clears project milestones when an issue moves to another project, and milestone filtering. Adds migration 8.
- Added workspace labels with colors and descriptions, a label management page with rename, recolor, archive, and restore, multi-label assignment on issues, label badges that do not rely on color, and any or all label filtering. Archived labels stay on existing issues. Adds migration 7.
- Added issue search across titles and description text, combinable status, priority, project, and due date filters with removable chips and reset, sorting with stable tie-breaks, and paged results through `query_issues` and migration 6.
- Added All Issues and issue detail pages with Open, Closed, and All filters, ISS numbers, status and priority indicators, quick completion and reopening, rich-text descriptions with autosave, properties, project links, and a project-scoped issue list.
- Added typed issue commands to create, list, edit, complete, cancel, reopen, and move issues between projects and the Inbox, with idempotent lifecycle timestamps.
- Added the issue data model: migration 5 with per-workspace ISS numbers allocated in a transaction, optional same-workspace projects, Tiptap descriptions, and a derived closed state.
- Added workspace-scoped projects with creation, editing, search, status filters, and archiving.

- Added local documents: create, list, and edit with Tiptap JSON, stored per workspace behind typed Tauri commands, with automatic saving and migration 3.
- Added `app_state` and typed Rust access to the active workspace, with a data model guide and disposable-database tests for fresh and upgraded databases.
- Added local macOS verification and an automated SQLite migration test.
- Added Ubuntu Quick CI, Windows and Apple Silicon packaging validation, and contribution and release documentation.

## 0.1.0 — Phase 0 scaffold

- Added the Tauri desktop shell, feature previews, persisted appearance settings, and the initial SQLite workspace migration.
