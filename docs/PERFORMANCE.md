# Performance and accessibility

This records the U2-027 audit: how to repeat the measurements, the results, what was fixed, and the gaps left open. Rerun the fixtures after changes to queries, list rendering, or theme tokens.

## Targets

- **Backend.** Each query a page sends finishes within one frame (16 ms) at 5,000 issues, except deliberate full-workspace reads such as export.
- **Rendering.** At 500 issues, each main page shows its content within 200 ms of navigation, with no main-thread task over 50 ms.
- **Accessibility.** No automated WCAG 2.2 AA violations on any page or open panel, in light or dark mode. Every keyboard stop shows a focus indicator. Form fields have borders of at least 3:1 (WCAG 1.4.11). No page scrolls sideways at the window's minimum width of 620 px.

## Backend queries

`src-tauri/src/perf_tests.rs` builds disposable file databases and times each query 20 times after a warm-up. The 500-issue workspace represents daily personal use. The 5,000-issue workspace shows the headroom. Each fixture has 12 projects, 8 labels, 12 milestones, a mission with an objective, and issues spread across statuses, the Inbox, three months of due dates, labels, milestones, and parent links.

```sh
cargo test --release --manifest-path src-tauri/Cargo.toml perf_tests -- --ignored --nocapture
```

Release build, Apple M5, macOS 26.5.1:

| Query                              | 500 issues | 5,000 issues |
| ---------------------------------- | ---------: | -----------: |
| Issues: first page (open, updated) |    0.57 ms |      2.13 ms |
| Issues: text search                |    0.22 ms |      2.29 ms |
| Issues: label + priority filters   |    0.39 ms |      4.62 ms |
| Board: one status column           |    0.87 ms |      2.48 ms |
| Today: due today or overdue        |    1.10 ms |      4.91 ms |
| Calendar: one month                |    1.08 ms |      4.29 ms |
| Project overview                   |    1.09 ms |      9.26 ms |
| Project goals with rollups         |    0.13 ms |      0.15 ms |
| Milestones with counts             |    0.81 ms |      8.46 ms |
| Workspace search                   |    0.46 ms |      3.64 ms |
| All issues (relationship picker)   |    3.86 ms |     42.09 ms |
| JSON export                        |    4.04 ms |     39.54 ms |

Every page query meets the target at both sizes, so no index or query was changed. The two full-workspace reads scale linearly, as expected. Export runs only when asked. The relationship picker is listed under gaps.

## Rendering

`tests/browser/performance.spec.ts` seeds the in-memory IPC mock and times in-app navigation until each page's first content is visible, taking the median of three runs. It also sums main-thread long tasks over 50 ms. The mock answers instantly, so these numbers measure the UI only. Add the backend time above for the full cost. The fixture is opt-in because wall-clock times vary by machine.

```sh
PERF=1 npx playwright test performance --reporter=line
```

Chromium (Playwright), Apple M5:

| Page                            | 500 issues | 2,000 issues |                             Long tasks |
| ------------------------------- | ---------: | -----------: | -------------------------------------: |
| Issues list                     |      78 ms |        79 ms |                                   none |
| Board (via the issue list)      |     178 ms |       180 ms |                                   none |
| Today                           |      94 ms |        98 ms |                                   none |
| Calendar                        |      76 ms |       141 ms |                                   none |
| Project overview (via Projects) |     112 ms |       114 ms |                                   none |
| Relationship picker, opening    |      50 ms |        79 ms | none, one 50 ms task in an earlier run |

The board and overview timings each include two navigations. Lists and board columns are paged, so their cost does not grow with the workspace. The calendar and picker load every matching issue, so they grow with it but stay within the target at 2,000 issues.

## Accessibility audit

`tests/browser/accessibility.spec.ts` runs in `npm run test:browser`:

- **Pages.** It runs axe-core (`@axe-core/playwright`, WCAG 2.0 to 2.2 A and AA rules) on 21 pages with seeded records in light and dark mode, with reduced motion requested.
- **Interactive states.** It scans open panels in both modes: the search dialog with an active result, the board's Move menu, the relationship form, the archived banner and deletion panel, the project dialog, and the keyboard shortcut help.
- **Focus.** It tabs through eight pages in both modes and fails on any stop without an outline of at least 2 px or a focus shadow.
- **Field borders.** It checks every visible text field, select, and text area, or the row that frames it, for a 3:1 border against what is behind it. Axe does not check this.
- **Reflow.** It fails if any page scrolls sideways at 620 px, the minimum window width in `tauri.conf.json`.

The existing browser tests cover the main workflows by keyboard: capture with N, search with F and ⌘K, list traversal and completion, board Move menus, and the deletion and import confirmations.

### Defects found and fixed

| Defect                                                                                         | Where                                                                                                            | Fix                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Accent text on the selection tint was 4.35:1, below 4.5:1                                      | Light mode: active navigation, `.action` buttons, status badges, pressed filters, on all 21 pages (116 elements) | `--accent` darkened from `#5263cf` to `#4c5ecd`, the nearest shade of the same hue that is at least 4.5:1 on every light surface        |
| Form field borders were 1.25:1 (light) and 1.5:1 (dark)                                        | Every text field, select, and text area, and the underlined title fields                                         | New `--control-line` token (`#85838c` light, `#8c8890` dark) for field borders. `--line` stays for decorative dividers                  |
| Status links' names did not include their visible text, so voice control could not target them | Project overview, Issues by status                                                                               | Removed the `aria-label`. A visually hidden "issues" completes the visible "To Do 3"                                                    |
| Search results listbox held a button, headers, and notes, which listboxes cannot own           | Workspace search                                                                                                 | "See all" is now the group's last option, reachable with the arrow keys. Group headers name their group but are hidden from the listbox |
| No focus indicator                                                                             | Description editor, and date fields once focus moves to their parts or picker button                             | `.ProseMirror:focus-visible` ring. Date fields ring on `:focus-within`                                                                  |
| The search input had `outline: none` and no replacement                                        | Workspace search                                                                                                 | The field row shows an accent underline while focused                                                                                   |
| The board widened the whole page, for example by 732 px at 620 px                              | Board pages                                                                                                      | Visually hidden column text was positioned against the page. The board is now its own containing block, so it scrolls inside its region |

Reduced motion: the app's own CSS has no animations or transitions. A global `prefers-reduced-motion` rule now also stops library animations, such as the calendar's drag revert.

## Gaps

- **Relationship picker at large sizes.** Adding a relationship loads every issue and renders one `<select>` option per issue: 42 ms backend and 80 ms rendering at 2,000 to 5,000 issues, and slow to scan by keyboard. It meets the target at the representative size. A searchable picker backed by `query_issues` would remove the full load. This is proposed as a follow-up issue rather than built speculatively here.
- **Native WebKit.** The rendering and accessibility checks run in Chromium. The macOS app uses WebKit, so check focus rings, date fields, and contrast in the native smoke test.
- **Screen readers.** Automated checks do not replace a pass with VoiceOver, which has not been run.
