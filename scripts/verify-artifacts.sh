#!/usr/bin/env bash
# Verifies the installers a packaging job produced and writes SHA-256 checksums
# plus a build manifest next to them (U2-P6-19).
#
#   scripts/verify-artifacts.sh <windows|macos> <folder> <version> [updater]
#
# Windows must hold BOTH the NSIS setup and the MSI, labeled x64.
# macOS must hold the DMG, labeled aarch64 (Apple Silicon).
# A folder with a missing file, a wrong architecture label, or an empty file fails.
# With `updater` (U2-P7-03), the signed updater packages are required too: a
# `.sig` per Windows installer, and the macOS `.app.tar.gz` with its `.sig`,
# each signature bound to this version and made by the key embedded in
# src-tauri/tauri.conf.json (or UPDATER_PUBKEY, for tests) (docs/UPDATER_SIGNING.md).
# Any file that looks like a private signing key fails the check in every mode.
set -euo pipefail

platform="${1:?usage: verify-artifacts.sh <windows|macos> <folder> <version> [updater]}"
dir="${2:?folder}"
version="${3:?version}"
updater="${4:-}"
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
[[ -d "$dir" ]] || fail "Folder '$dir' does not exist."

case "$platform" in
  windows) expected=("Unhollowed 2_${version}_x64-setup.exe" "Unhollowed 2_${version}_x64_en-US.msi") ;;
  macos) expected=("Unhollowed 2_${version}_aarch64.dmg") ;;
  *) fail "Platform must be windows or macos, not '$platform'." ;;
esac
[[ -z "$updater" || "$updater" == updater ]] || fail "The fourth argument must be 'updater' or nothing."

# The private key starts with this comment, in plain text or base64.
if grep -rqaE 'rsign encrypted secret key|dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5' "$dir"; then
  fail "A private signing key was found in '$dir'. Do not upload anything; remove it and rotate the key (docs/UPDATER_SIGNING.md)."
fi

signatures=()
# Bytes 2-9 of a minisign key or signature are the key ID.
key_id() { sed -n 2p | base64 --decode | od -An -tx1 -j2 -N8 | tr -d ' \n'; }
if [[ "$updater" == updater ]]; then
  pubkey="${UPDATER_PUBKEY:-$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).plugins.updater.pubkey" "$(dirname "$0")/../src-tauri/tauri.conf.json")}"
  expected_key="$(base64 --decode <<< "$pubkey" | key_id)"
  [[ ${#expected_key} -eq 16 ]] || fail "Could not read the embedded updater public key."
  [[ "$platform" == macos ]] && expected+=("Unhollowed 2_${version}_aarch64.app.tar.gz")
  for name in "${expected[@]}"; do [[ "$name" == *.dmg ]] || signatures+=("$name.sig"); done
fi

for name in "${expected[@]}"; do
  [[ -f "$dir/$name" ]] || fail "Missing expected installer: $name"
  [[ -s "$dir/$name" ]] || fail "Installer is empty: $name"
done

# A Tauri signature is base64 of minisign text. Its trusted comment, which the
# signature covers, names the version the package was signed for.
for sig in ${signatures[@]+"${signatures[@]}"}; do
  [[ -s "$dir/$sig" ]] || fail "Missing or empty updater signature: $sig"
  decoded="$(base64 --decode < "$dir/$sig" 2>/dev/null)" || fail "Updater signature is not base64: $sig"
  grep -q '^trusted comment: .*version:'"$version"'$' <<< "$decoded" ||
    fail "Updater signature is not bound to version $version: $sig"
  [[ "$(key_id <<< "$decoded")" == "$expected_key" ]] ||
    fail "Updater signature was made by a different key than the embedded one: $sig"
done

# Nothing else that looks like an installer may be present, so a stale or
# mislabeled file is never uploaded with the release.
shopt -s nullglob
for file in "$dir"/*.exe "$dir"/*.msi "$dir"/*.dmg "$dir"/*.tar.gz "$dir"/*.sig; do
  base="$(basename "$file")"
  listed=false
  for name in "${expected[@]}" ${signatures[@]+"${signatures[@]}"}; do [[ "$base" == "$name" ]] && listed=true; done
  $listed || fail "Unexpected installer in the release folder: $base"
done

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
(cd "$dir" && : > SHA256SUMS && for name in "${expected[@]}" ${signatures[@]+"${signatures[@]}"}; do sha256 "$name" >> SHA256SUMS; done)

{
  echo "product: Unhollowed 2"
  echo "version: $version"
  echo "platform: $platform"
  echo "commit: ${GITHUB_SHA:-unknown}"
  echo "ref: ${GITHUB_REF:-unknown}"
  echo "run: ${GITHUB_RUN_ID:-local} attempt ${GITHUB_RUN_ATTEMPT:-1}"
  echo "runner: ${RUNNER_OS:-$(uname -s)} ${RUNNER_ARCH:-$(uname -m)}"
  echo "signature: recorded in the job log by the signature step; unsigned validation builds are not for distribution (docs/RELEASE.md)"
  if [[ -n "$updater" ]]; then echo "updater packages: signed, bound to $version"; else echo "updater packages: none"; fi
} > "$dir/BUILD-INFO.txt"

echo "Verified ${#expected[@]} installer(s) for $platform $version. Checksums:"
cat "$dir/SHA256SUMS"
