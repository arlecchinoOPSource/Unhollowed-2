# Changelog

## Unreleased

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
