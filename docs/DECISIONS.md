# Engineering decisions

- Keep the Phase 0 scaffold as the baseline on `main` and develop the infrastructure through a PR.
- Use Ubuntu for routine remote checks, macOS locally for daily native verification, and dedicated hosted builds for installers.
- Test SQLite migrations against disposable databases. Use stable IDs and preserve migration history.
- Every record belongs to one workspace through a required `workspace_id` foreign key with `ON DELETE RESTRICT`. The active workspace lives in a single-row `app_state` table instead of a hard-coded ID. See [data model](DATA_MODEL.md).
- Keep packaging artifact-only. Release publication is a separate maintainer action.
