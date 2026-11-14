# Architecture

React Router renders the workspace and feature routes in the Tauri webview. Zustand persists appearance. The production build bundles UI assets and Inter locally.

The database adapter in `src/database` calls the Rust command through Tauri IPC. The SQL plugin initializes SQLite in Tauri's application-specific config directory. Rust handles queries and errors. The main window currently has no plugin permissions.

The initial migration seeds a workspace with a stable ID, and the second records it as the active workspace in `app_state`. Rust reads the active workspace through `active_workspace` and returns typed errors to the webview. Future records use their own UUIDs and a required `workspace_id` foreign key. Documents are stored as Tiptap JSON and reached through typed commands in `src-tauri/src/documents.rs`. The editor in `src/features/documents` saves changes automatically and disables Tiptap's injected stylesheet because the production content security policy blocks inline styles. See [Data model](DATA_MODEL.md) for ownership, ID, foreign-key, and migration rules.
