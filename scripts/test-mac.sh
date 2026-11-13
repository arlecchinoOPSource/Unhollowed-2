#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
mode="${1:-quick}"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

run() {
  local label="$1"
  shift
  printf '\n==> %s\n' "$label"
  "$@" || fail "$label failed. See the output above."
}

[[ "$mode" == quick || "$mode" == full ]] || fail "Use quick or full."
[[ "$(uname -s)" == Darwin ]] || fail "This command requires macOS."
xcode-select -p >/dev/null 2>&1 && xcrun --show-sdk-path >/dev/null 2>&1 ||
  fail "Install the Xcode Command Line Tools with xcode-select --install."
command -v node >/dev/null && command -v npm >/dev/null ||
  fail "Install Node.js $(cat .nvmrc) and npm (for example, nvm install && nvm use)."
[[ "$(node -p 'process.versions.node')" == "$(cat .nvmrc)" ]] ||
  fail "Use Node.js $(cat .nvmrc). With nvm, run nvm install && nvm use."
command -v rustup >/dev/null ||
  fail "Install Rust from https://rustup.rs/ and restart your shell."
toolchain=$(sed -n 's/^channel = "\([^"]*\)"/\1/p' rust-toolchain.toml)
rustup run "$toolchain" cargo fmt --version >/dev/null 2>&1 ||
  fail "Run rustup toolchain install $toolchain --profile minimal --component rustfmt."
[[ -x node_modules/.bin/vite && -x node_modules/.bin/tauri ]] ||
  fail "Run npm ci to install project dependencies."

run "ESLint" npm run lint
run "Frontend unit tests" npm test
run "TypeScript and frontend production build" npm run build
run "Rust formatting" cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
run "Tauri/Rust compilation and SQLite tests" cargo test --locked --manifest-path src-tauri/Cargo.toml

if [[ "$mode" == full ]]; then
  run "Optimized macOS app bundle" npm run desktop:build -- --ci --no-sign --bundles app --config '{"build":{"beforeBuildCommand":null}}' -- --locked
  binary="src-tauri/target/release/bundle/macos/Unhollowed 2.app/Contents/MacOS/unhollowed-2"
  run "Verify the bundle executable" test -x "$binary"
  run "Verify the bundle architecture" lipo "$binary" -verify_arch "$(uname -m)"
fi

printf '\nmacOS %s checks passed.\n' "$mode"
