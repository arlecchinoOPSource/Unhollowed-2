# Unhollowed 2

A free, local-first desktop workspace by Arlecchino for connecting documents, projects, and personal routines. The current build includes Home, local documents with a rich-text editor, feature previews, appearance settings, and a local SQLite workspace.

Built with Tauri 2, Rust, SQLite, React, TypeScript, and Vite. GitHub Issues and milestones track upcoming work.

## Set up

Use the Node version in `.nvmrc`, npm, and rustup. Rust is pinned in `rust-toolchain.toml`. On macOS, install the Xcode command line tools with `xcode-select --install`. On Windows, install the Microsoft C++ Build Tools and WebView2 Runtime. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for platform setup.

```sh
npm ci
npx playwright install chromium
```

| Command                                                     | Purpose                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| `npm run dev`                                               | Start the Vite browser preview on port 1420               |
| `npm run desktop`                                           | Start Tauri in development mode                           |
| `npm run build`                                             | Type-check and build the frontend                         |
| `npm run desktop:build`                                     | Build and bundle the desktop app for the host             |
| `npm run desktop:build -- --bundles app`                    | Build only the macOS app bundle                           |
| `npm run typecheck`                                         | Check TypeScript                                          |
| `npm run lint`                                              | Run ESLint                                                |
| `npm run format`                                            | Format source and documentation                           |
| `npm run format:check`                                      | Check formatting                                          |
| `npm test`                                                  | Run the Vitest suite                                      |
| `npm run test:mac`                                          | Run local macOS frontend, Rust, and SQLite checks         |
| `npm run test:mac:full`                                     | Also build and verify an optimized local macOS app bundle |
| `npm run test:browser`                                      | Run Chromium smoke tests                                  |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Check Rust formatting                                     |

Dependency installation needs internet access. The built app serves its UI and fonts locally. It can open without Vite, an account, or internet access.

## Architecture

- `src/app` defines routes and navigation. `src/components/layout` provides the common workspace shell. `src/features` holds feature UI as it grows.
- `src/styles/workspace.css` holds the theme tokens. The wordmark and headings use a locally installed Role Serif font when available and fall back to Georgia. Inter is bundled for interface text.
- `src/stores/theme.ts` persists the theme in the webview's local storage. The system preference sets the initial theme.
- `src/database/status.ts` calls the typed desktop command. In Rust, Tauri's SQL plugin preloads `workspace.sqlite3` under the application-specific config directory and applies migrations. On macOS this is `~/Library/Application Support/dev.arlecchino.unhollowed2/`.
- **Settings → Check local storage** queries the seeded Personal workspace through Tauri IPC. The main window has no plugin permissions. Rust owns the connection and query.

The workspace uses a stable UUID stored as text, and `app_state` records which workspace is active. As features are implemented, give their rows independent UUIDs and a required `workspace_id` foreign key. Add new migration files and preserve migrations already applied to existing databases. The [data model](docs/DATA_MODEL.md) documents the conventions.

## Phase 1

1. Add document links and the graph view on top of the local documents.
2. Add persistence tests covering database reopen, migration upgrades, and write failures.
3. Validate Windows development, WebView2 startup, and installer behavior on Windows. Add repeatable native smoke coverage for both platforms.

See [Phase 0 verification](docs/phase-0.md) for resolved versions and checks.

## Project documentation

- [Product](docs/PRODUCT.md), [architecture](docs/ARCHITECTURE.md), and [data model](docs/DATA_MODEL.md)
- [Development](docs/DEVELOPMENT.md) and [local macOS testing](docs/MACOS_TESTING.md)
- [CI and packaging](docs/CI_CD.md) and [release preparation](docs/RELEASE.md)
- [Contributing](docs/CONTRIBUTING.md), [decisions](docs/DECISIONS.md), and [changelog](CHANGELOG.md)
