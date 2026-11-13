# Engineering decisions

- Keep the Phase 0 scaffold as the baseline on `main`; develop the infrastructure through a PR.
- Use Ubuntu for routine remote checks, macOS locally for daily native verification, and dedicated hosted builds for installers.
- Test SQLite migrations against disposable databases. Use stable IDs and preserve migration history.
- Keep packaging artifact-only. Release publication is a separate maintainer action.
