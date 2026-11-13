# CI and desktop packaging

| Workflow          | Automatic runs                                                                              | Manual runs             |
| ----------------- | ------------------------------------------------------------------------------------------- | ----------------------- |
| Quick CI          | Every PR to `main` and push to `main`                                                       | Ubuntu checks           |
| Desktop packaging | Windows x64 on relevant pushes to `main`. Windows x64 and Apple Silicon on `v*` tag pushes. | Windows, macOS, or both |

Quick CI runs lint, frontend unit tests, TypeScript plus the production web build, Rust formatting, and native Rust compilation and tests. Ubuntu installs the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/) needed to compile. Desktop packaging produces workflow artifacts. See [GitHub-hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) for the runner architectures.

The workflows restore npm's download cache using `package-lock.json` and use Cargo caches keyed by runner and toolchain. Quick CI saves the Rust cache on `main` pushes so PRs can reuse it. Superseded Quick CI runs for the same PR are canceled. Packaging uses a separate concurrency group per run. The workflow tokens have read access to contents and Actions dependencies use reviewed commit SHAs.

Open Actions → workflow → run to inspect the queue and step logs. A queued job has no setup logs yet. Once assigned a runner, use the named setup steps to distinguish OS packages, toolchain installation, npm installation, cache restore, and compilation failures. Check runner capacity and billing for persistent queue delays. For a transient failure, use **Re-run failed jobs** or `gh run rerun RUN_ID --failed`. For a deterministic failure, fix it on the branch and push a new commit. Use local macOS testing for everyday work and manually dispatch macOS packaging for installer validation.

## First hosted run

GitHub registered Quick CI on the setup PR. Its [first run](https://github.com/arlecchinoOPSource/Unhollowed-2/actions/runs/43416002083) failed before any steps started. The job annotation points to account payments or the Actions spending limit. Review **Settings → Billing & plans** and resolve the account restriction, then rerun the PR check. Workflow dispatch requires the packaging workflow on the default branch. After the setup PR is merged, dispatch **Desktop packaging** for both platforms and record the results.

## Protecting main

GitHub returned HTTP 403 for both rulesets and branch protection on this private repository. Keeping the repository private requires a plan with private repository protection, such as [GitHub Pro](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) for a personal account.

Once protection is available, go to Settings → Rules → Rulesets, create an active branch ruleset targeting the default branch, and block deletions and force pushes. Require pull requests and select **Quick checks (Ubuntu)** from GitHub Actions after it has reported successfully. Keep approvals at zero for a solo-maintainer repository. Set an owner or administrator bypass for emergencies if available. Keep Actions read-only and restrict release publication to authorized maintainers.
