# Working on Unhollowed 2

- Use the GitHub issue as the scope. Create a branch such as `feat/U2-001-description`, `fix/U2-002-description`, `chore/U2-003-description`, or `docs/U2-004-description` and open a PR to `main`. Preserve other contributors' edits and existing history.
- Keep feature UI under `src/features` and reuse shared layout, theme tokens, and navigation. Change the design only when the issue calls for it. Keep UI keyboard-accessible.
- Keep persistence in Rust. Expose narrow typed commands and use parameterized queries. Keep the app usable offline and avoid accounts, telemetry, remote assets, and unnecessary desktop permissions.
- Add numbered, forward-only SQL migrations. Preserve previously shipped migration files, stable IDs, and user data. Test upgrades against disposable fixtures, including legacy data where relevant. Never reset a user's database to fix a test.
- Use npm and commit dependency changes with `package-lock.json` or `src-tauri/Cargo.lock`. Use the pinned Node and Rust versions. Prefer existing code and small, readable changes.
- Before submitting application changes, run `npm run test:mac` on macOS or the individual Quick CI commands in [development](docs/DEVELOPMENT.md). Run the Chromium smoke test for navigation or appearance changes and the full native check for packaging changes. Record results and any platform gaps in the PR.
- Review AI-generated changes for correctness, data compatibility, permissions, and unnecessary dependencies. Report only checks that actually ran. Do not include private data or credentials in issues, logs, or commits.
