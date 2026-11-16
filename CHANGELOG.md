# Changelog

## Unreleased

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
