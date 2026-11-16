import { expect, test, type Page } from "@playwright/test";
import type {
  Issue,
  IssueFields,
  IssueQuery,
  IssueStatus,
} from "../../src/database/issues";
import type { Project } from "../../src/database/projects";

test.beforeEach(async ({ page }) => {
  // This exercises the UI with an in-memory substitute for Tauri IPC that
  // follows the backend's lifecycle rules. Rust tests cover SQLite and the
  // real commands.
  await page.addInitScript(() => {
    const empty = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    const projects: Project[] = [
      {
        id: "project-1",
        name: "Studio launch",
        description: null,
        status: "active",
        startDate: null,
        targetDate: null,
        createdAt: "2026-11-14T00:00:00Z",
        updatedAt: "2026-11-14T00:00:00Z",
      },
    ];
    // Tests can preload issues by defining window.__seedIssues in their own
    // init script. That script runs after this one, so seeds load on the
    // first IPC call.
    const issues: Issue[] = [];
    let seeded = false;
    const seed = () =>
      (
        (window as unknown as { __seedIssues?: Partial<Issue>[] })
          .__seedIssues ?? []
      ).map((seed, index): Issue => ({
        id: `seed-${index + 1}`,
        number: index + 1,
        projectId: null,
        title: `Seed ${index + 1}`,
        description: empty,
        status: "todo",
        priority: "none",
        startDate: null,
        dueDate: null,
        completedAt: null,
        closed: seed.status === "done" || seed.status === "canceled",
        createdAt: `2026-11-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
        updatedAt: `2026-11-01T00:${String(index % 60).padStart(2, "0")}:00Z`,
        ...seed,
      }));
    let clock = 0;
    let delayedList: Promise<void> | undefined;
    if (location.search.includes("delay-list")) {
      delayedList = new Promise((resolve) => {
        window.addEventListener("release-list", () => resolve(), {
          once: true,
        });
      });
    }
    const failing = new Set<string>();
    // Failures last until cleared, because React's development StrictMode
    // runs each load effect twice.
    window.addEventListener("fail-command", (event) => {
      failing.add((event as CustomEvent<string>).detail);
    });
    window.addEventListener("restore-command", (event) => {
      failing.delete((event as CustomEvent<string>).detail);
    });
    const now = () =>
      new Date(Date.UTC(2026, 10, 16, 0, 0, clock++)).toISOString();
    const find = (id?: string) => {
      const issue = issues.find((item) => item.id === id);
      if (!issue) throw { code: "not_found" };
      return issue;
    };
    const setStatus = (issue: Issue, status: IssueStatus) => {
      if (issue.status === status) return issue;
      issue.status = status;
      issue.closed = status === "done" || status === "canceled";
      issue.completedAt =
        status === "done" ? (issue.completedAt ?? now()) : null;
      issue.updatedAt = now();
      return issue;
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (
          command: string,
          args: {
            id?: string;
            input?: IssueFields;
            projectId?: string | null;
            status?: IssueStatus;
            query?: IssueQuery;
          } = {},
        ) => {
          if (!seeded) {
            seeded = true;
            issues.push(...seed());
          }
          if (failing.has(command)) throw { code: "storage_failed" };
          switch (command) {
            case "list_projects":
              return projects;
            case "get_project": {
              const project = projects.find((item) => item.id === args.id);
              if (!project) throw { code: "not_found" };
              return project;
            }
            case "query_issues": {
              // Mirrors the backend's filter, sort, and paging rules.
              const q = args.query!;
              const text = q.text?.trim().toLowerCase();
              const matches = issues.filter(
                (issue) =>
                  (!text ||
                    `${issue.title}\n${issue.description}`
                      .toLowerCase()
                      .includes(text)) &&
                  (!q.statuses?.length || q.statuses.includes(issue.status)) &&
                  (!q.priorities?.length ||
                    q.priorities.includes(issue.priority)) &&
                  (!(q.projectIds?.length || q.inbox) ||
                    (issue.projectId
                      ? (q.projectIds ?? []).includes(issue.projectId)
                      : Boolean(q.inbox))) &&
                  (q.undated === "only"
                    ? !issue.dueDate
                    : issue.dueDate
                      ? (!q.dueAfter || issue.dueDate >= q.dueAfter) &&
                        (!q.dueBefore || issue.dueDate <= q.dueBefore)
                      : q.undated !== "exclude"),
              );
              const open = matches.filter((issue) => !issue.closed).length;
              const inState = matches.filter(
                (issue) =>
                  !q.state ||
                  q.state === "all" ||
                  (q.state === "closed") === issue.closed,
              );
              const rank = ["none", "low", "medium", "high", "urgent"];
              const key = (issue: Issue): string | number =>
                ({
                  updated: issue.updatedAt,
                  created: issue.createdAt,
                  priority: rank.indexOf(issue.priority),
                  title: issue.title.toLowerCase(),
                  due: issue.dueDate ?? "",
                })[q.sort ?? "updated"];
              const sign = q.direction === "asc" ? 1 : -1;
              inState.sort((a, b) => {
                if (q.sort === "due" && !a.dueDate !== !b.dueDate)
                  return a.dueDate ? -1 : 1;
                const [x, y] = [key(a), key(b)];
                return (
                  (x < y ? -sign : x > y ? sign : 0) ||
                  sign * (a.number - b.number)
                );
              });
              const offset = q.offset ?? 0;
              const snapshot = structuredClone({
                issues: inState.slice(offset, offset + (q.limit ?? 100)),
                total: inState.length,
                open,
                closed: matches.length - open,
              });
              await delayedList;
              return snapshot;
            }
            case "get_issue":
              return structuredClone(find(args.id));
            case "create_issue": {
              const time = now();
              const issue: Issue = {
                id: `issue-${issues.length + 1}`,
                number: issues.length + 1,
                projectId: args.projectId ?? null,
                title: args.input!.title,
                description: args.input!.description ?? empty,
                status: "todo",
                priority: args.input!.priority ?? "none",
                startDate: args.input!.startDate,
                dueDate: args.input!.dueDate,
                completedAt: null,
                closed: false,
                createdAt: time,
                updatedAt: time,
              };
              issues.push(issue);
              return structuredClone(issue);
            }
            case "update_issue": {
              const issue = find(args.id);
              const input = args.input!;
              if (
                input.startDate &&
                input.dueDate &&
                input.startDate > input.dueDate
              )
                throw { code: "invalid_date_range" };
              Object.assign(issue, {
                ...input,
                description: input.description ?? empty,
                priority: input.priority ?? "none",
                updatedAt: now(),
              });
              return structuredClone(issue);
            }
            case "change_issue_status":
              return structuredClone(setStatus(find(args.id), args.status!));
            case "complete_issue":
              return structuredClone(setStatus(find(args.id), "done"));
            case "reopen_issue": {
              const issue = find(args.id);
              return structuredClone(
                issue.closed ? setStatus(issue, "todo") : issue,
              );
            }
            case "set_issue_project": {
              const issue = find(args.id);
              if (
                args.projectId &&
                !projects.some((item) => item.id === args.projectId)
              )
                throw { code: "invalid_project" };
              issue.projectId = args.projectId ?? null;
              issue.updatedAt = now();
              return structuredClone(issue);
            }
          }
          throw new Error(`Unexpected command: ${command}`);
        },
      },
      isTauri: true,
    });
  });
});

async function createIssue(page: Page, title: string) {
  // Submitting with Enter keeps focus in the field for the next issue.
  await page.getByLabel("New issue").fill(title);
  await page.getByLabel("New issue").press("Enter");
  await expect(page.getByText(/^Created ISS-\d+\.$/)).toBeVisible();
}

test("lists, completes, and reopens issues with open and closed filters", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await nav.getByRole("link", { name: "Issues" }).click();
  await expect(
    page.getByRole("heading", { name: "No issues yet" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Create issue" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter an issue title.");
  await expect(page.getByLabel("New issue")).toBeFocused();
  await createIssue(page, "Draft outline");
  await createIssue(page, "Book venue");
  await expect(page.getByLabel("New issue")).toBeFocused();

  const open = page.getByRole("list", { name: "Open issues" });
  await expect(open.getByRole("listitem")).toHaveCount(2);
  await expect(open.getByText("ISS-1")).toBeVisible();
  await expect(open.getByText("ISS-2")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page
    .getByRole("button", { name: "Complete ISS-2: Book venue" })
    .click();
  await expect(page.getByText("ISS-2 completed.")).toBeVisible();
  await expect(open.getByRole("listitem")).toHaveCount(1);
  // Focus moves to the row that took the completed issue's place.
  await expect(
    page.getByRole("button", { name: "Complete ISS-1: Draft outline" }),
  ).toBeFocused();

  await page.getByRole("button", { name: /^Closed/ }).click();
  await expect(page).toHaveURL(/state=closed/);
  const closed = page.getByRole("list", { name: "Closed issues" });
  await expect(closed.getByText("Done")).toBeVisible();
  await closed
    .getByRole("button", { name: "Reopen ISS-2: Book venue" })
    .click();
  await expect(page.getByText("ISS-2 reopened.")).toBeVisible();
  await expect(page.getByText("No closed issues match.")).toBeVisible();
  await expect(page.getByLabel("New issue")).toBeFocused();

  await page.getByRole("button", { name: /^All/ }).click();
  await expect(
    page.getByRole("list", { name: "All issues" }).getByRole("listitem"),
  ).toHaveCount(2);
});

test("opens an issue, saves edits and properties, and links to its project", async ({
  page,
}) => {
  await page.goto("/issues");
  await createIssue(page, "Draft outline");
  await page.getByRole("link", { name: "Draft outline" }).click();
  await expect(page).toHaveURL(/\/issues\/issue-1$/);
  await expect(page.getByText("ISS-1", { exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await expect(nav.getByRole("link", { name: "Issues" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.getByLabel("Issue title").fill("Final outline");
  const description = page.getByRole("textbox", { name: "Issue description" });
  await description.click();
  await page.getByRole("button", { name: "Bold" }).click();
  // The toolbar returns focus to the editor on the next animation frame.
  await expect(description).toBeFocused();
  await page.keyboard.type("Key points");
  await expect(page.getByText("All changes saved")).toBeVisible();

  const status = page.getByLabel("Status");
  await status.focus();
  await status.selectOption("in_progress");
  await expect(page.getByText("Status changed to In Progress.")).toBeVisible();
  await expect(status).toBeFocused();

  await page.getByLabel("Priority").selectOption("high");
  await page.getByLabel("Due date").fill("2026-12-01");
  await page.getByLabel("Start date").fill("2026-12-05");
  await expect(page.getByRole("alert")).toHaveText(
    "The due date must be on or after the start date.",
  );
  await expect(page.getByLabel("Start date")).toHaveValue("");

  await page.getByLabel("Project").selectOption("project-1");
  await expect(page.getByText("Moved to Studio launch.")).toBeVisible();

  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(page.getByText("Issue completed.")).toBeVisible();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();

  // Leave and reopen the issue: everything was saved.
  await page.getByRole("link", { name: "All issues" }).click();
  await page.getByRole("button", { name: /^All/ }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Final outline" });
  await expect(row.getByText("High")).toBeVisible();
  await expect(row.getByRole("link", { name: "Studio launch" })).toBeVisible();
  await row.getByRole("link", { name: "Final outline" }).click();
  await expect(page.getByLabel("Issue title")).toHaveValue("Final outline");
  await expect(description.locator("strong")).toHaveText("Key points");
  await expect(page.getByLabel("Status")).toHaveValue("done");
  await expect(page.getByLabel("Priority")).toHaveValue("high");
  await expect(page.getByLabel("Due date")).toHaveValue("2026-12-01");

  await page.getByRole("button", { name: "Reopen issue" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("todo");
  await page.getByRole("link", { name: "Open project Studio launch" }).click();
  await expect(page).toHaveURL(/\/projects\/project-1$/);
  await expect(
    page.getByRole("heading", { name: "Studio launch", level: 1 }),
  ).toBeVisible();
});

test("saves a title typed just before leaving the page", async ({ page }) => {
  await page.goto("/issues");
  await createIssue(page, "Quick note");
  await page.getByRole("link", { name: "Quick note" }).click();
  await page.getByLabel("Issue title").fill("Quick note, revised");
  // Leave before the autosave delay elapses.
  await page.getByRole("link", { name: "All issues" }).click();
  await expect(
    page.getByRole("link", { name: "Quick note, revised" }),
  ).toBeVisible();
});

test("shows a project's issues through the same list", async ({ page }) => {
  await page.goto("/issues");
  await createIssue(page, "Inbox item");
  // Navigate inside the app: a reload would reset the in-memory IPC state.
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await nav.getByRole("link", { name: "Projects" }).click();
  await page.getByRole("link", { name: /Studio launch/ }).click();
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Issues/ })
    .click();
  await expect(page).toHaveURL(/\/projects\/project-1\/issues$/);
  await expect(page.getByText("Work planned for Studio launch.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No issues in this project yet" }),
  ).toBeVisible();
  await createIssue(page, "Print posters");
  await expect(page.getByRole("link", { name: "Inbox item" })).toHaveCount(0);

  await page.getByRole("link", { name: "Print posters" }).click();
  await expect(page.getByLabel("Project")).toHaveValue("project-1");
  await page.getByRole("link", { name: "Project issues" }).click();
  await expect(page).toHaveURL(/\/projects\/project-1\/issues$/);

  await nav.getByRole("link", { name: "Issues" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Print posters" });
  await expect(row.getByText("ISS-2")).toBeVisible();
  await expect(row.getByRole("link", { name: "Studio launch" })).toBeVisible();
});

test("handles missing issues and storage failures", async ({ page }) => {
  await page.goto("/issues/missing");
  await expect(
    page.getByRole("heading", { name: "Issue unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText("This issue is unavailable in the current workspace."),
  ).toBeVisible();

  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fail-command", { detail: "query_issues" }),
    ),
  );
  await page.getByRole("link", { name: "All issues" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not access local issue storage.",
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("restore-command", { detail: "query_issues" }),
    ),
  );
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("heading", { name: "No issues yet" }),
  ).toBeVisible();

  await createIssue(page, "Fragile");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fail-command", { detail: "complete_issue" }),
    ),
  );
  await page.getByRole("button", { name: "Complete ISS-1: Fragile" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Could not access local issue storage. Try again.",
  );
  await expect(
    page.getByRole("button", { name: "Complete ISS-1: Fragile" }),
  ).toBeVisible();
});

test("recovers a failed draft after leaving and saves it on retry", async ({
  page,
}) => {
  await page.goto("/issues");
  await createIssue(page, "Original issue");
  await page.getByRole("link", { name: "Original issue" }).click();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fail-command", { detail: "update_issue" }),
    ),
  );
  await page.getByLabel("Issue title").fill("Recover this edit");
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();
  await page.getByRole("link", { name: "All issues" }).click();
  await page.getByRole("link", { name: "Original issue" }).click();
  await expect(page.getByLabel("Issue title")).toHaveValue("Recover this edit");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("restore-command", { detail: "update_issue" }),
    ),
  );
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByText("All changes saved")).toBeVisible();
  await page.getByRole("link", { name: "All issues" }).click();
  await expect(
    page.getByRole("link", { name: "Recover this edit" }),
  ).toBeVisible();
});

test("keeps a typed title while waiting for the initial list before creating", async ({
  page,
}) => {
  await page.goto("/issues?delay-list");
  const title = page.getByLabel("New issue");
  await title.fill("Created after loading");
  const create = page.getByRole("button", { name: "Create issue" });
  await expect(create).toBeDisabled();
  await title.press("Enter");
  await expect(title).toHaveValue("Created after loading");
  await page.evaluate(() => window.dispatchEvent(new Event("release-list")));
  await expect(create).toBeEnabled();
  await title.press("Enter");
  await expect(
    page.getByRole("link", { name: "Created after loading" }),
  ).toBeVisible();
  await expect(page.getByText("Created ISS-1.")).toBeVisible();
});

function seedIssues(page: Page, seeds: Partial<Issue>[]) {
  return page.addInitScript((data) => {
    Object.assign(window, { __seedIssues: data });
  }, seeds);
}

test("searches, combines filters, resets them, and sorts undated issues last", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-16T10:00:00"));
  const rich = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Meet at the Café" }],
      },
    ],
  });
  await seedIssues(page, [
    {
      title: "Alpha",
      priority: "high",
      dueDate: "2026-11-10",
      projectId: "project-1",
    },
    { title: "Bravo", priority: "low" },
    {
      title: "Charlie",
      priority: "urgent",
      dueDate: "2099-01-01",
      status: "done",
    },
    {
      title: "Delta",
      priority: "high",
      projectId: "project-1",
      description: rich,
    },
    { title: "Echo", dueDate: "2026-11-20" },
  ]);
  await page.goto("/issues");
  const list = page.getByRole("list", { name: "Open issues" });
  const rows = list.getByRole("link", {
    name: /^(Alpha|Bravo|Delta|Echo|Charlie)$/,
  });
  await expect(rows).toHaveCount(4);
  await expect(page.getByRole("button", { name: /^Closed/ })).toContainText(
    "1",
  );

  // Search reads rich description text.
  await page.getByLabel("Search issues").fill("café");
  await expect(rows).toHaveText(["Delta"]);
  await expect(page).toHaveURL(/q=caf%C3%A9/);
  await page
    .getByRole("button", { name: "Remove filter Search: “café”" })
    .click();
  await expect(page.getByLabel("Search issues")).toHaveValue("");
  await expect(rows).toHaveCount(4);

  // Filters combine.
  await page.getByRole("combobox", { name: /^Priority/ }).selectOption("high");
  await page
    .getByRole("combobox", { name: /^Project/ })
    .selectOption("project-1");
  await page.getByRole("combobox", { name: /^Sort by/ }).selectOption("title");
  await expect(rows).toHaveText(["Alpha", "Delta"]);
  await page.getByRole("combobox", { name: /^Due date/ }).selectOption("none");
  await expect(rows).toHaveText(["Delta"]);
  await page
    .getByRole("combobox", { name: /^Due date/ })
    .selectOption("overdue");
  await expect(rows).toHaveText(["Alpha"]);
  const chips = page.getByRole("list", { name: "Active filters" });
  await expect(chips.getByRole("button")).toHaveText([
    "Priority: High",
    "Project: Studio launch",
    "Due: Overdue",
  ]);

  // Filters survive opening an issue and coming back.
  await page.getByRole("link", { name: "Alpha" }).click();
  await page.getByRole("link", { name: "All issues" }).click();
  await expect(page.getByRole("combobox", { name: /^Priority/ })).toHaveValue(
    "high",
  );
  await expect(rows).toHaveText(["Alpha"]);

  await page.getByLabel("Search issues").fill("nothing like this");
  await expect(page.getByText("No issues match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(chips).toBeHidden();
  await expect(page.getByLabel("Search issues")).toHaveValue("");
  await expect(page.getByRole("combobox", { name: /^Sort by/ })).toHaveValue(
    "title",
  );
  await expect(rows).toHaveText(["Alpha", "Bravo", "Delta", "Echo"]);

  // Undated issues stay last in both directions, ordered by number.
  await page.getByRole("combobox", { name: /^Sort by/ }).selectOption("due");
  await expect(rows).toHaveText(["Alpha", "Echo", "Bravo", "Delta"]);
  await page
    .getByRole("button", { name: "Sorted ascending. Switch to descending" })
    .click();
  await expect(rows).toHaveText(["Echo", "Alpha", "Delta", "Bravo"]);
  await expect(page).toHaveURL(/sort=due&dir=desc/);
});

test("loads long lists in pages without repeating issues", async ({ page }) => {
  await seedIssues(
    page,
    Array.from({ length: 120 }, (_, index) => ({
      title: `Bulk ${index + 1}`,
    })),
  );
  await page.goto("/issues?sort=title");
  const items = page
    .getByRole("list", { name: "Open issues" })
    .getByRole("listitem");
  await expect(items).toHaveCount(50);
  await expect(page.getByText("Showing 50 of 120")).toBeVisible();
  await page.getByRole("button", { name: "Load more issues" }).click();
  await expect(items).toHaveCount(100);
  await page.getByRole("button", { name: "Load more issues" }).click();
  await expect(page.getByText("Showing 120 of 120")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more issues" }),
  ).toBeHidden();
  const keys = await items.locator(".issue-key").allTextContents();
  expect(new Set(keys).size).toBe(120);
});
