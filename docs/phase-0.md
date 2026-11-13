# Phase 0 verification

Validated on Apple Silicon macOS with Node 24.22.2, npm 11.19.1, Rust 1.99.1, Cargo 1.99.1, and the Xcode command line tools.

| Check                                              | Result                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm dependency installation and lockfile reinstall | Passed                                                                                                                                                                 |
| npm audit                                          | Zero reported vulnerabilities                                                                                                                                          |
| TypeScript, ESLint, Prettier, and Rust formatting  | Passed                                                                                                                                                                 |
| Vite production build                              | Passed                                                                                                                                                                 |
| Vitest                                             | 2 tests passed                                                                                                                                                         |
| Chromium smoke test                                | 1 test passed. Opened Home and every sidebar route, toggled the sidebar by keyboard, and verified theme persistence after reload. External HTTP requests were blocked. |
| Tauri development startup                          | Vite and the native executable started                                                                                                                                 |
| macOS app bundles                                  | Debug and optimized Apple Silicon builds succeeded                                                                                                                     |
| macOS desktop smoke                                | Opened the bundled Home screen and confirmed the selected theme survived quitting and reopening                                                                        |
| Live Tauri IPC and SQLite                          | Settings read the seeded Personal workspace. The on-disk SQLite database recorded migration 1 as successful.                                                           |
| Offline runtime                                    | The bundled desktop app rendered Home and read SQLite with local assets and no Vite server. The browser smoke also blocked requests outside the local Vite origin.     |

Windows startup and installer behavior, macOS DMG creation, signing, and notarization remain unverified. The macOS app bundle was built locally. Git was initialized on main and the scaffold is uncommitted.

The existing ArlecchinoCore copy under Swish provides suite UI for the older apps. This scaffold uses its own shared shell and neutral design tokens to match the new design. FullCalendar packages use matching 6.1.22 versions. The npm override pins the development-only minimatch dependency to 11.0.1 until the lint dependencies adopt a patched version.

## Resolved direct npm dependencies

| Package                      | Version |
| ---------------------------- | ------- |
| `@eslint/js`                 | 10.0.1  |
| `@fontsource-variable/inter` | 5.3.0   |
| `@fullcalendar/core`         | 6.1.22  |
| `@fullcalendar/daygrid`      | 6.1.22  |
| `@fullcalendar/react`        | 6.1.22  |
| `@playwright/test`           | 1.65.0  |
| `@tauri-apps/api`            | 2.12.4  |
| `@tauri-apps/cli`            | 2.12.4  |
| `@testing-library/jest-dom`  | 7.0.1   |
| `@testing-library/react`     | 16.3.3  |
| `@tiptap/pm`                 | 3.33.1  |
| `@tiptap/react`              | 3.33.1  |
| `@tiptap/starter-kit`        | 3.33.1  |
| `@types/node`                | 26.6.6  |
| `@types/react`               | 19.3.0  |
| `@types/react-dom`           | 19.3.0  |
| `@vitejs/plugin-react`       | 6.3.0   |
| `cytoscape`                  | 3.35.0  |
| `date-fns`                   | 4.4.0   |
| `eslint`                     | 10.14.0 |
| `eslint-plugin-react-hooks`  | 7.1.1   |
| `globals`                    | 17.14.0 |
| `jsdom`                      | 31.0.1  |
| `lucide-react`               | 1.72.0  |
| `prettier`                   | 3.10.1  |
| `react`                      | 19.3.1  |
| `react-dom`                  | 19.3.1  |
| `react-router`               | 8.5.1   |
| `typescript`                 | 6.0.3   |
| `typescript-eslint`          | 8.72.2  |
| `vite`                       | 8.3.8   |
| `vitest`                     | 5.1.0   |
| `zustand`                    | 5.1.0   |

## Resolved direct Rust dependencies

| Crate            | Version |
| ---------------- | ------- |
| tauri            | 2.12.5  |
| tauri-build      | 2.7.4   |
| tauri-plugin-sql | 2.6.0   |
| sqlx             | 0.8.6   |
| serde            | 1.0.229 |
| serde_json       | 1.0.154 |

The npm and Cargo lockfiles record transitive versions.
