#!/usr/bin/env bash
# Checks that a release tag matches the code it points at (U2-P6-19).
#
#   scripts/verify-release-tag.sh <tag>
#
# 1. The tag is `v` plus the SemVer version in package.json and tauri.conf.json.
# 2. The tagged commit is reachable from origin/main, so only reviewed code is released.
#
# REPO_ROOT defaults to the repository that holds this script. The workflow
# fetches the full history first. Whether Quick CI passed for the commit is
# checked separately in the workflow, where the GitHub API is available.
set -euo pipefail

tag="${1:?usage: verify-release-tag.sh <tag>}"
root="${REPO_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }

[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
  fail "Tag '$tag' is not v<SemVer>, for example v1.0.0-beta.1."
expected="${tag#v}"

json_version() { node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version" "$1"; }
for file in package.json src-tauri/tauri.conf.json; do
  found="$(json_version "$root/$file")"
  [[ "$found" == "$expected" ]] ||
    fail "$file says version $found but the tag is $tag. Release PRs set every version first (docs/VERSIONING.md)."
done

git -C "$root" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null ||
  fail "origin/main is not available. Fetch the full history before running this check."
git -C "$root" merge-base --is-ancestor HEAD refs/remotes/origin/main ||
  fail "The tagged commit $(git -C "$root" rev-parse --short HEAD) is not on main. Tag only reviewed, merged commits."

printf 'Tag %s matches version %s and commit %s is on main.\n' "$tag" "$expected" "$(git -C "$root" rev-parse --short HEAD)"
