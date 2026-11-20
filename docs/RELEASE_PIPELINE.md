# Release and updater feed pipeline

How a reviewed, signed release reaches the in-app updater (U2-P7-07, #259). Signing and the key are in [Updater signing](UPDATER_SIGNING.md); the check, download, and install are in [Updater](UPDATER.md); the release checklist is in [Release](RELEASE.md).

**The rule:** the beta feed (`latest.json` on the `updater-beta` release) never points at anything until the packages it names are published, publicly downloadable, verified, and approved for distribution. The feed changes last, in its own approved step.

## Sequence

| Step                      | Where                                                                       | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Build                  | **Desktop packaging**, on the `v*` tag push                                 | Builds the DMG, NSIS setup, and MSI from the exact tagged commit after `verify-tag` checks that the tag matches every version, the commit is on `main`, and Quick CI passed for it. Ordinary installers are built exactly as before.                                                                                                                                                                                                                                                                                                                        |
| 2. Sign                   | same job, `updater-signing` environment                                     | Tauri signs the updater packages (`.app.tar.gz`, setup, MSI) with the owner's key, bound to the version.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3. Verify                 | same job                                                                    | `verify-artifacts.sh … updater` checks every package and `.sig`, the bound version, the key ID, and that no private key is present, and writes `SHA256SUMS` and `BUILD-INFO.txt`. Artifacts are kept 7 days.                                                                                                                                                                                                                                                                                                                                                |
| 4. Test                   | owner, with the job's artifacts                                             | Native checks from [Release](RELEASE.md) and the acceptance plan in #260.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5. Publish assets         | **Release publish** → `verify`, then `publish` (`release-publish` approval) | `verify` (read-only) downloads both platforms' artifacts from Desktop packaging runs of the **same commit**, checks their checksums and `BUILD-INFO` commit, re-runs the artifact checks, builds `latest.json` with `updater-manifest.mjs`, and checks it offline with `updater-feed.mjs`. After approval, `publish` creates the release (a prerelease for `-beta`/`-rc` versions, never marked latest) and uploads the installers, signatures, `SHA256SUMS`, both `BUILD-INFO` files, and the candidate `latest.json`. Existing assets are never replaced. |
| 6. Validate public assets | `publish`                                                                   | `updater-feed.mjs` downloads every package from its **public** URL and checks its digest and full signature.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 7. Approve distribution   | `promote` (`updater-feed` approval)                                         | A separate approval: publishing assets does not distribute them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8. Update the feed last   | `promote`                                                                   | Re-checks the published candidate in full, refuses a version that is not newer than the live feed, uploads it as the feed's `latest.json`, and confirms the public feed serves exactly those bytes.                                                                                                                                                                                                                                                                                                                                                         |

A failure at any step stops the run before the next one. A platform job that failed or was cancelled leaves `verify` without its artifacts, so it fails, and nothing is published or promoted. An incomplete or mismatched manifest cannot reach the feed: `updater-feed.mjs` requires all five targets, the right release URL for each installer family, matching digests, a valid signature by the embedded key for the manifest's version, and a newer version than the live feed.

No ordinary CI run publishes anything. Desktop packaging and Quick CI keep `contents: read`. Only the two manual workflows below can write releases, and only after an approval. Nothing depends on GitHub's "latest release": every release is created with `--latest=false`, and the feed lives at a fixed tag.

## What the owner sets up once

Create two environments in **Settings → Environments**, next to `updater-signing`:

| Environment       | Required reviewers | Deployment branches and tags                                    | Secrets |
| ----------------- | ------------------ | --------------------------------------------------------------- | ------- |
| `release-publish` | the owner          | selected only: tags `v*`                                        | none    |
| `updater-feed`    | the owner          | selected only: tags `v*` and the branch `main` (for withdrawal) | none    |

The workflows use only `github.token`, with `contents: write` limited to these two approved jobs.

## Running it

1. Merge the release PR, push the `v*` tag, and wait for **Desktop packaging** (both platforms) to succeed.
2. **Actions → Release publish → Run workflow** from the tag, with the tag and **dry run** checked. This publishes to an isolated release `dry-run-<tag>` and feed `updater-dry-run`, which no app reads. Approve both steps and read the summaries.
3. Run it again with **dry run** unchecked. Approve **publish**, check the release page, finish acceptance (#260), then approve **promote**.

The packaging artifacts expire after 7 days. Re-run Desktop packaging for the tag if they have.

### macOS runner fallback

If the hosted macOS runner stalls, re-run the failed **Package macos** job of the tag's Desktop packaging run, or start a new run on the tag. Then pass that run's ID as `macos_run`. A real release accepts only runs started by the tag push, so a new run must be a re-run of that push. Locally built packages are not accepted: the pipeline only publishes artifacts whose run, commit, and checksums it can check.

## Withdrawing a faulty update

Run **Actions → Updater feed withdraw** (approval `updater-feed`):

- **`restore_tag` set** to an earlier good release: the feed offers that release again. It must still verify in full. Apps already on the faulty version stay on it, because the updater never downgrades. Apps below it can still update to the good release.
- **`restore_tag` empty:** the feed's `latest.json` is deleted. Checks then fail with "The update server did not answer correctly", and nothing is offered.

To also stop downloads of the faulty packages, delete them from their release or mark the release as a draft. **Withdrawing does not undo installed updates:** there is no rollback. Ship a fixed, higher version through the same pipeline, and tell affected users that they can install an earlier version by hand from its release ([recovery](UPDATER.md#recovery-when-installation-fails)).

## Tests

| What      | Where                                                  | Cases                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feed gate | `tests/unit/updaterFeed.test.tsx` (`updater-feed.mjs`) | Complete manifest accepted. Missing asset, changed asset (digest mismatch), changed asset with a forged digest (signature mismatch), wrong key, signature for another version, missing target, MSI pointing at NSIS, HTTP URL, another release's URL, malformed JSON, invalid version, version not newer than the live feed (equal, older) all rejected. `--allow-older` accepted for withdrawal. SemVer ordering. |
| Manifest  | `tests/unit/updaterManifest.test.tsx`                  | Mapping per installer family, dry-run release URLs, missing package or signature, wrong version or key, package that does not match its signature.                                                                                                                                                                                                                                                                 |
| Artifacts | `tests/unit/releaseScripts.test.tsx`                   | Unchanged from U2-P7-03 (signatures, versions, key IDs, private-key scan).                                                                                                                                                                                                                                                                                                                                         |
| Workflows | GitHub, after merge                                    | Not run yet: a workflow can be dispatched only once it is on `main`. Do the dry run in step 2 for the first updater release, and test a withdrawal on the dry-run feed.                                                                                                                                                                                                                                            |

## Gaps

- The workflows have not run on GitHub: they need to be on `main`, a `v*` tag with signed packages for both platforms (the next release PR), and the two environments above.
- Native acceptance of a real update installed from the feed is #260.
