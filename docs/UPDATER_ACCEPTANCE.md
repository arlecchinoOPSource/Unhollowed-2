# Native updater acceptance

Use the public `v1.0.0-beta.1` installer, a local `1.1.0-beta.0` acceptance client, and the signed `1.1.0-beta.1` release candidate. The acceptance client reads the isolated `updater-dry-run` feed. The real candidate continues to read `updater-beta`. Both use the same application identity and retain Tauri's embedded public key and signed-version requirement.

## Set up the candidate

1. Build signed Apple Silicon macOS and Windows x64 release artifacts using **Desktop packaging** from the reviewed release tag. The owner approves the signing environment. Verify that both jobs produced checksums and the expected signatures.
2. Run **Release publish** from the tag with **dry run** enabled. After the separate approvals, confirm that both the isolated release assets and its feed are public and that the feed offers exactly `1.1.0-beta.1`. The production feed must remain unchanged.
3. On each native platform, build the older test client from that same source tree:

   ```sh
   npm run desktop:build -- --ci --no-sign --config src-tauri/tauri.updater-acceptance.conf.json -- --locked
   ```

   The lower app and MSI versions are deliberate. The older client itself needs no updater signature because it is installed manually. The update it installs still requires the production updater signature. Build this client in a separate checkout or target directory so its output cannot be confused with release artifacts. Confirm Settings reports `1.1.0-beta.0` before checking for updates.

## Run on disposable native systems

Use snapshots or separate test machines with empty profiles. The acceptance build retains the public bundle identifier and Windows upgrade identity, so never install it over an everyday workspace. On Windows use separate disposable installs for NSIS and MSI. On macOS install into a writable Applications folder in the test environment.

1. On one fixture per installer family, install the published initial beta, seed a representative workspace, then manually install the signed candidate from the dry-run release using the same installer family. Verify records, version, paths, and installer registration.
2. From a separate clean snapshot, install the older acceptance client and seed a workspace. On startup and while idle, verify that no updater requests are made. Open the sidebar control and verify the isolated feed offers `1.1.0-beta.1`.
3. Install the signed update. Exercise a pending document edit and verify that a save failure stops installer handoff. On a successful run, verify native installer selection, exit or relaunch, Settings version, restored page, and a one-time success notice. Compare the workspace before and after, including documents, projects, issues, calendar, habits, mood, and dashboards.
4. Exercise offline behavior and validate that a withdrawn or unavailable feed leaves the installed app usable. Exercise malformed metadata, missing assets, rejected signatures and interrupted transfers using controlled fixtures. Never replace production release assets or bypass signature verification to simulate a failure.
5. Run **Updater feed withdraw** with **dry run** enabled and verify that the isolated feed stops offering the candidate. Record the exact commit, artifact hashes, OS and installer family, test outcomes, and remaining gaps on #258, #259 and #260. Promote the production feed only after the release and acceptance review.

Use fresh snapshots for retries. The candidate replaces the client's configuration on a successful update, so the upgraded app will read the production feed on its *next user-initiated* check. Stop the test at post-relaunch verification unless that next check has been separately planned.
