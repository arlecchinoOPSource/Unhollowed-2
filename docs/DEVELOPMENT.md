# Development

Use the Node version in `.nvmrc` and Rust with rustup. The Rust toolchain file selects the compiler and rustfmt.

```sh
nvm install
nvm use
npm ci
npm run desktop
```

For the browser-only preview, run `npm run dev`. Use `npx playwright install chromium` once and `npm run test:browser` for browser smoke tests.

Run these commands from the project root to reproduce Quick CI after installing the platform prerequisites and npm dependencies.

```sh
npm run lint
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

The build includes TypeScript checking. Cargo compiles Tauri and tests the SQLite migration with a disposable in-memory database. The production frontend build must precede the Rust test so Tauri can find its configured assets.
