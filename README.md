# Unhollowed 2

A free, local-first desktop workspace by Arlecchino. Phase 0 includes Home, feature previews, appearance settings, and a local SQLite workspace.

## Set up

Use Node.js 24 LTS, npm, and stable Rust. On macOS, install the Xcode command line tools with `xcode-select --install`. On Windows, install the Microsoft C++ Build Tools and WebView2 Runtime. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for platform setup.

```sh
npm ci
npx playwright install chromium
```

| Command                                                     | Purpose                                       |
| ----------------------------------------------------------- | --------------------------------------------- |
| `npm run dev`                                               | Start the Vite browser preview on port 1420   |
| `npm run desktop`                                           | Start Tauri in development mode               |
| `npm run build`                                             | Type-check and build the frontend             |
| `npm run desktop:build`                                     | Build and bundle the desktop app for the host |
| `npm run desktop:build -- --bundles app`                    | Build only the macOS app bundle               |
| `npm run typecheck`                                         | Check TypeScript                              |
| `npm run lint`                                              | Run ESLint                                    |
| `npm run format`                                            | Format source and documentation               |
| `npm run format:check`                                      | Check formatting                              |
| `npm test`                                                  | Run the Vitest suite                          |
| `npm run test:browser`                                      | Run Chromium smoke tests                      |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Check Rust formatting                         |

Dependency installation needs internet access. The built app serves its UI and fonts locally. It can open without Vite, an account, or internet access.

## Architecture

- `src/app` defines routes and navigation. `src/components/layout` provides the common workspace shell. `src/features` holds feature UI as it grows.
- `src/styles/workspace.css` holds the theme tokens. The wordmark and headings use a locally installed Role Serif font when available and fall back to Georgia. Inter is bundled for interface text.
- `src/stores/theme.ts` persists the theme in the webview's local storage. The system preference sets the initial theme.
- `src/database/status.ts` calls the typed desktop command. In Rust, Tauri's SQL plugin preloads `workspace.sqlite3` under the application-specific config directory and applies migrations. On macOS this is `~/Library/Application Support/dev.arlecchino.unhollowed2/`.
- **Settings → Check local storage** queries the seeded Personal workspace through Tauri IPC. The main window has no plugin permissions. Rust owns the connection and query.

The workspace uses a stable UUID stored as text. As features are implemented, give their rows independent UUIDs and a foreign key to the owning workspace. Use explicit foreign keys for optional project or task relationships. Document links and graph edges can use document IDs. Add new migration files and preserve migrations already applied to existing databases.

## Phase 1

1. Implement document creation and editing with Tiptap JSON, typed Rust commands, and migrations keyed by workspace.
2. Add persistence tests covering database reopen, migration upgrades, and write failures.
3. Validate Windows development, WebView2 startup, and installer behavior on Windows. Add repeatable native smoke coverage for both platforms.

See [Phase 0 verification](docs/phase-0.md) for resolved versions and checks.
