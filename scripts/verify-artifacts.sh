#!/usr/bin/env bash
# Verifies the installers a packaging job produced and writes SHA-256 checksums
# plus a build manifest next to them (U2-P6-19).
#
#   scripts/verify-artifacts.sh <windows|macos> <folder> <version>
#
# Windows must hold BOTH the NSIS setup and the MSI, labeled x64.
# macOS must hold the DMG, labeled aarch64 (Apple Silicon).
# A folder with a missing file, a wrong architecture label, or an empty file fails.
set -euo pipefail

platform="${1:?usage: verify-artifacts.sh <windows|macos> <folder> <version>}"
dir="${2:?folder}"
version="${3:?version}"
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
[[ -d "$dir" ]] || fail "Folder '$dir' does not exist."

case "$platform" in
  windows) expected=("Unhollowed 2_${version}_x64-setup.exe" "Unhollowed 2_${version}_x64_en-US.msi") ;;
  macos) expected=("Unhollowed 2_${version}_aarch64.dmg") ;;
  *) fail "Platform must be windows or macos, not '$platform'." ;;
esac

for name in "${expected[@]}"; do
  [[ -f "$dir/$name" ]] || fail "Missing expected installer: $name"
  [[ -s "$dir/$name" ]] || fail "Installer is empty: $name"
done

# Nothing else that looks like an installer may be present, so a stale or
# mislabeled file is never uploaded with the release.
shopt -s nullglob
for file in "$dir"/*.exe "$dir"/*.msi "$dir"/*.dmg; do
  base="$(basename "$file")"
  listed=false
  for name in "${expected[@]}"; do [[ "$base" == "$name" ]] && listed=true; done
  $listed || fail "Unexpected installer in the release folder: $base"
done

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
(cd "$dir" && : > SHA256SUMS && for name in "${expected[@]}"; do sha256 "$name" >> SHA256SUMS; done)

{
  echo "product: Unhollowed 2"
  echo "version: $version"
  echo "platform: $platform"
  echo "commit: ${GITHUB_SHA:-unknown}"
  echo "ref: ${GITHUB_REF:-unknown}"
  echo "run: ${GITHUB_RUN_ID:-local} attempt ${GITHUB_RUN_ATTEMPT:-1}"
  echo "runner: ${RUNNER_OS:-$(uname -s)} ${RUNNER_ARCH:-$(uname -m)}"
  echo "signature: recorded in the job log by the signature step; unsigned validation builds are not for distribution (docs/RELEASE.md)"
} > "$dir/BUILD-INFO.txt"

echo "Verified ${#expected[@]} installer(s) for $platform $version. Checksums:"
cat "$dir/SHA256SUMS"
