# Local macOS testing

Use a native Apple Silicon shell on the development Mac. Verify that `uname -m` reports `arm64`. Install the pinned Node version with `nvm install && nvm use`, install [rustup](https://rustup.rs/), then run these commands from the repository root.

```sh
rustup toolchain install 1.99.1 --profile minimal --component rustfmt
npm ci
npm run test:mac
```

The quick command validates prerequisites, lints, runs frontend tests, checks TypeScript and builds the frontend, checks Rust formatting, and compiles and tests Tauri and SQLite. Use [Development](DEVELOPMENT.md) to run the checks individually.

Run `npm run test:mac:full` for changes to native dependencies, capabilities, startup, or bundling. It also builds an optimized local app bundle and verifies its executable architecture. For a persistent log in zsh or Bash, use:

```sh
set -o pipefail
npm run test:mac:full 2>&1 | tee /tmp/unhollowed-2-mac.log
```

Before merging a native change, open the app and verify Home, Settings → Check local storage, and any affected behavior.

```sh
open "src-tauri/target/release/bundle/macos/Unhollowed 2.app"
```

The SQLite test uses a fresh in-memory database. The normal desktop app uses its application config directory, so use sample data for manual testing and preserve any existing workspace.

- If `xcode-select -p` or `xcrun --show-sdk-path` fails, run `xcode-select --install`. If Xcode is already installed, select the correct Command Line Tools in Xcode Settings → Locations.
- If packages are missing or out of sync with the lockfile, run `npm ci`. If rustup reports a missing compiler or rustfmt, rerun the toolchain install above.
- Local macOS testing covers your Mac and avoids routine hosted macOS jobs. Ubuntu Quick CI checks compilation and tests independently. Windows installers and macOS disk images are handled by Desktop packaging.

## Phase 0.5 verification

The quick and full commands passed on Apple Silicon macOS 26.5.1. Two frontend tests and the SQLite migration test passed, and the optimized app bundle contained an arm64 executable. An unsigned disk image was also built and verified with `hdiutil verify`. The disk-image check verifies packaging integrity. Distribution signing, notarization, and clean-machine installer tests are separate release checks.
