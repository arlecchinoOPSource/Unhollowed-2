# Architecture

React Router renders the workspace and feature routes in the Tauri webview. Zustand persists appearance. The production build bundles UI assets and Inter locally.

The database adapter in `src/database` calls the Rust command through Tauri IPC. The SQL plugin initializes SQLite in Tauri's application-specific config directory. Rust handles queries and errors. The main window currently has no plugin permissions.

The initial migration seeds a workspace with a stable ID. Future records should use their own stable IDs and explicitly reference the owning workspace. Establish scoped queries and foreign-key behavior before expanding the feature schema.
