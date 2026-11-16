import { expect, test, type Page } from "@playwright/test";
import type {
  Issue,
  IssueFields,
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
    const issues: Issue[] = [];
    let clock = 0;
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
          } = {},
        ) => {
          if (failing.has(command)) throw { code: "storage_failed" };
          switch (command) {
            case "list_projects":
              return projects;
            case "get_project": {
              const project = projects.find((item) => item.id === args.id);
              if (!project) throw { code: "not_found" };
              return project;
            }
            case "list_issues":
              return structuredClone(
                issues
                  .filter(
                    (issue) =>
                      !args.projectId || issue.projectId === args.projectId,
                  )
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
              );
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
  await expect(page.getByText("No closed issues.")).toBeVisible();
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
      new CustomEvent("fail-command", { detail: "list_issues" }),
    ),
  );
  await page.getByRole("link", { name: "All issues" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not access local issue storage.",
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("restore-command", { detail: "list_issues" }),
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
