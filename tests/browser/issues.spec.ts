import { expect, test, type Page } from "@playwright/test";
import type { Issue } from "../../src/database/issues";
import { dispatch, installIpcMock } from "./ipcMock";

test.beforeEach(({ page }) => installIpcMock(page));

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
  await page.clock.setFixedTime(new Date("2026-11-16T10:00:00-05:00"));
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

test("creates labels, assigns several, filters by them, and keeps archived labels visible", async ({
  page,
}) => {
  await seedIssues(page, [{ title: "Fix sink" }, { title: "Read paper" }]);
  await page.goto("/issues");
  await page.getByRole("link", { name: "Manage labels" }).first().click();
  await expect(page).toHaveURL(/\/issues\/labels$/);
  await expect(
    page.getByRole("heading", { name: "No labels yet" }),
  ).toBeVisible();

  const create = page.getByRole("form", { name: "Create a label" });
  for (const [name, color] of [
    ["Home", "green"],
    ["Urgent errand", "red"],
    ["Reading", "teal"],
  ]) {
    await create.getByLabel("Label name").fill(name);
    await create.getByLabel("Color").selectOption(color);
    await create.getByRole("button", { name: "Create label" }).click();
    await expect(page.getByText(`Created label ${name}.`)).toBeVisible();
    // Focus returns to the empty name field for the next label.
    await expect(create.getByLabel("Label name")).toBeFocused();
  }
  await create.getByLabel("Label name").fill("home");
  await create.getByRole("button", { name: "Create label" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "A label with this name already exists. Archived labels keep their names.",
  );

  // Rename and recolor inline.
  await page.getByRole("button", { name: "Edit Urgent errand" }).click();
  const edit = page.getByRole("form", { name: "Edit Urgent errand" });
  await expect(edit.getByLabel("Label name")).toBeFocused();
  await edit.getByLabel("Label name").fill("Errand");
  await edit.getByLabel("Color").selectOption("orange");
  await edit.getByRole("button", { name: "Save label" }).click();
  await expect(page.getByText("Saved label Errand.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Errand" })).toBeFocused();

  // Assign two labels with the keyboard.
  await page.getByRole("link", { name: "All issues" }).click();
  await page.getByRole("link", { name: "Fix sink" }).click();
  const picker = page.getByRole("group", { name: "Labels" });
  await picker.getByRole("checkbox", { name: /Home/ }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("Labels updated.")).toBeVisible();
  await picker.getByRole("checkbox", { name: /Errand/ }).focus();
  await page.keyboard.press("Space");
  await expect(picker.getByRole("checkbox", { name: /Errand/ })).toBeChecked();
  await expect(picker.getByRole("checkbox", { name: /Errand/ })).toBeFocused();
  await page.getByRole("link", { name: "All issues" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Fix sink" });
  await expect(row.getByRole("list", { name: "Labels" })).toHaveText(
    /Errand\s*Home/,
  );

  // Filter by any or all labels.
  await page.getByText("Labels", { exact: true }).click();
  const filter = page.getByRole("group", {
    name: "Show issues with these labels",
  });
  // These checkboxes follow the URL, which updates just after the click.
  for (const name of [/Home/, /Reading/]) {
    await filter.getByRole("checkbox", { name }).click();
    await expect(filter.getByRole("checkbox", { name })).toBeChecked();
  }
  const titles = page
    .getByRole("list", { name: "Open issues" })
    .getByRole("link", { name: /^(Fix sink|Read paper)$/ });
  await expect(titles).toHaveText(["Fix sink"]);
  await page.getByLabel("Match all selected labels").click();
  await expect(page.getByText("No issues match these filters.")).toBeVisible();
  await expect(page).toHaveURL(/match=all/);
  // Close the label popup before interacting with the controls behind it.
  await page.getByText("Labels (2)", { exact: true }).click();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(titles).toHaveCount(2);

  // Archive: the badge stays on the issue and says so in text.
  await page.getByRole("link", { name: "Manage labels" }).first().click();
  await page.getByRole("button", { name: "Archive Home" }).click();
  await expect(
    page.getByRole("button", { name: "Restore Home" }),
  ).toBeFocused();
  await page.getByRole("link", { name: "All issues" }).click();
  await expect(row.getByText("archived")).toBeVisible();
  // It is not offered for new assignment.
  await page.getByRole("link", { name: "Read paper" }).click();
  await expect(
    page
      .getByRole("group", { name: "Labels" })
      .getByRole("checkbox", { name: /Home/ }),
  ).toHaveCount(0);
  // It can still be removed from the issue that has it.
  await page.getByRole("link", { name: "All issues" }).click();
  await page.getByRole("link", { name: "Fix sink" }).click();
  const archived = page
    .getByRole("group", { name: "Labels" })
    .getByRole("checkbox", { name: /Home/ });
  await expect(archived).toBeChecked();
  await archived.focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("Labels updated.")).toBeVisible();
  // It stays listed and focused, but cannot be added back while archived.
  await expect(archived).not.toBeChecked();
  await expect(archived).toBeFocused();
  await expect(archived).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Space");
  await expect(archived).not.toBeChecked();
  await expect(
    page.getByText("Archived labels can be removed but not added."),
  ).toBeVisible();
});

test("plans milestones, links compatible issues, and updates progress", async ({
  page,
}) => {
  await seedIssues(page, [
    { title: "Print posters", projectId: "project-1" },
    { title: "Book venue", projectId: "project-1" },
    { title: "Plant tulips", projectId: "project-2" },
  ]);
  await page.goto("/issues");
  await page.getByRole("link", { name: "Milestones" }).click();
  await expect(page).toHaveURL(/\/issues\/milestones$/);
  await expect(
    page.getByRole("heading", { name: "No milestones yet" }),
  ).toBeVisible();

  const create = page.getByRole("form", { name: "Create a milestone" });
  await create.getByLabel("Milestone title").fill("Opening night");
  await create.getByLabel("Applies to").selectOption("project-1");
  await create.getByLabel("Due date").fill("2026-12-20");
  await create.getByRole("button", { name: "Create milestone" }).click();
  await expect(
    page.getByText("Created milestone Opening night."),
  ).toBeVisible();
  await expect(create.getByLabel("Milestone title")).toBeFocused();
  await create.getByLabel("Milestone title").fill("Year review");
  await create.getByRole("button", { name: "Create milestone" }).click();
  await expect(page.getByText("Created milestone Year review.")).toBeVisible();

  const opening = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Opening night" }) });
  await expect(opening.getByText("No issues yet")).toBeVisible();
  await expect(
    opening.getByRole("link", { name: "Studio launch" }),
  ).toBeVisible();

  // Only compatible milestones are offered on an issue.
  await page.getByRole("link", { name: "All issues" }).click();
  await page.getByRole("link", { name: "Plant tulips" }).click();
  await expect(page.getByLabel("Issue title")).toHaveValue("Plant tulips");
  const milestone = page.getByRole("combobox", { name: /^Milestone/ });
  await expect(milestone.getByRole("option")).toHaveText([
    "No milestone",
    "Year review (workspace)",
  ]);
  await page.getByRole("link", { name: "All issues" }).click();
  for (const title of ["Print posters", "Book venue"]) {
    await page.getByRole("link", { name: title }).click();
    // Wait for the issue page: the list also has a Milestone filter.
    await expect(page.getByLabel("Issue title")).toHaveValue(title);
    await milestone.selectOption({ label: "Opening night" });
    await expect(
      page.getByText("Added to milestone Opening night."),
    ).toBeVisible();
    await page.getByRole("link", { name: "All issues" }).click();
  }

  // Completing an issue updates progress.
  await page
    .getByRole("button", { name: "Complete ISS-1: Print posters" })
    .click();
  await expect(page.getByText("ISS-1 completed.")).toBeVisible();
  await page.getByRole("link", { name: "Milestones" }).click();
  await expect(
    opening.getByText("1 of 2 complete (50%) · 1 open"),
  ).toBeVisible();
  await expect(
    opening.getByRole("progressbar", { name: "Progress for Opening night" }),
  ).toBeVisible();

  // Filtering the list by milestone.
  await opening
    .getByRole("link", { name: "View issues in Opening night" })
    .click();
  const list = page.getByRole("list", { name: "All issues" });
  await expect(
    list.getByRole("link", {
      name: /^(Print posters|Book venue|Plant tulips)$/,
    }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("button", {
      name: "Remove filter Milestone: Opening night",
    }),
  ).toBeVisible();

  // Moving an issue to another project removes its project milestone.
  await list.getByRole("link", { name: "Book venue" }).click();
  await expect(page.getByLabel("Issue title")).toHaveValue("Book venue");
  await page
    .getByRole("combobox", { name: /^Project/ })
    .selectOption("project-2");
  await expect(
    page.getByText(
      "Moved to Garden. Removed milestone Opening night because it belongs to another project.",
    ),
  ).toBeVisible();
  await expect(milestone).toHaveValue("");
  await page.getByRole("link", { name: "All issues" }).click();
  await page.getByRole("link", { name: "Milestones" }).click();
  await expect(
    opening.getByText("1 of 1 complete (100%) · 0 open"),
  ).toBeVisible();

  // Closing keeps the milestone on its issues.
  await opening.getByRole("button", { name: "Close Opening night" }).click();
  await expect(
    page.getByText("Closed Opening night. Its issues keep the milestone."),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Closed/ }).click();
  await expect(
    page.getByRole("list", { name: "Closed milestones" }).getByRole("heading"),
  ).toHaveText(["Opening night"]);
});

test("creates project goals with optional issue and mission links", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, {
      __seedIssues: [
        { title: "Publish brief", projectId: "project-1", status: "done" },
      ],
    }),
  );
  await page.goto("/projects/project-1");
  await page.getByRole("link", { name: /Missions & objectives/ }).click();
  await expect(page.getByText("No objectives yet.")).toBeVisible();
  await page.getByRole("button", { name: "New mission" }).click();
  await page.getByLabel("Title").fill("Launch studio");
  await page.getByRole("button", { name: "Save mission" }).click();
  await expect(
    page.getByRole("heading", { name: "Launch studio" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New objective" }).click();
  await page.getByLabel("Title").fill("Publish the launch brief");
  await page
    .getByRole("combobox", { name: "Mission", exact: true })
    .selectOption("sample-mission");
  await page.getByRole("checkbox", { name: /Publish brief/ }).check();
  await page.getByRole("button", { name: "Save objective" }).click();
  const card = (title: string) =>
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: title }) });
  // The objective and its mission both roll up the linked issue.
  await expect(card("Publish the launch brief")).toContainText(
    "1 of 1 issues done (100%)",
  );
  await expect(card("Launch studio")).toContainText(
    "1 of 1 issues done (100%)",
  );
  await page.getByRole("link", { name: /ISS-1 Publish brief/ }).click();
  await expect(page.getByLabel("Issue title")).toHaveValue("Publish brief");
  // Reopening the issue updates both rollups.
  await page.getByRole("button", { name: "Reopen issue" }).click();
  await expect(page.getByText("Issue reopened.")).toBeVisible();
  await page.getByRole("link", { name: "Missions & objectives" }).click();
  await expect(
    page.getByRole("heading", { name: "Publish the launch brief" }),
  ).toBeVisible();
  await expect(card("Publish the launch brief")).toContainText(
    "0 of 1 issues done (0%)",
  );
  await expect(card("Launch studio")).toContainText("0 of 1 issues done (0%)");
});

test("shows child progress and navigates from a closed sub-issue to its parent", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, {
      __seedIssues: [
        { title: "Plan launch" },
        { title: "Publish brief", status: "done" },
      ],
    }),
  );
  await page.goto("/issues/seed-1");
  await page.getByRole("button", { name: "Add relationship" }).click();
  const relationships = page.getByRole("region", { name: "Relationships" });
  await relationships.getByLabel("Relationship").selectOption("child");
  await relationships
    .getByRole("combobox", { name: "Issue", exact: true })
    .selectOption("seed-2");
  await relationships
    .getByRole("button", { name: "Save relationship" })
    .click();
  await expect(relationships.getByText("1 of 1 sub-issues done")).toBeVisible();
  await relationships
    .getByRole("link", { name: "ISS-2 Publish brief" })
    .click();
  await expect(page.getByLabel("Issue title")).toHaveValue("Publish brief");
  await relationships.getByRole("link", { name: "ISS-1 Plan launch" }).click();
  await expect(page.getByLabel("Issue title")).toHaveValue("Plan launch");
});

test("supports keyboard capture, search, issue navigation and completion", async ({
  page,
}) => {
  await page.goto("/");
  // Wait for the app to render so its shortcut listener is attached.
  await expect(
    page.getByRole("heading", { name: /^Good (morning|afternoon|evening)\.$/ }),
  ).toBeVisible();
  await page.keyboard.press("Alt+Shift+KeyN");
  const capture = page.getByLabel("New issue");
  await expect(capture).toBeFocused();
  await createIssue(page, "First keyboard issue");
  await createIssue(page, "Second keyboard issue");
  await capture.press("Alt+Shift+KeyF");
  await expect(capture).toBeFocused();
  await capture.press("Escape");
  await expect(page.getByRole("button", { name: /Open 2/ })).toBeFocused();
  await page.keyboard.press("Alt+Shift+KeyF");
  const search = page.getByLabel("Search issues");
  await expect(search).toBeFocused();
  await search.fill("keyboard issue");
  await search.press("Escape");
  await expect(page.getByRole("button", { name: /Open 2/ })).toBeFocused();
  const first = page.getByRole("link", { name: "First keyboard issue" });
  const second = page.getByRole("link", { name: "Second keyboard issue" });
  await second.focus();
  await second.press("ArrowDown");
  await expect(first).toBeFocused();
  await first.press("Enter");
  await expect(page.getByLabel("Issue title")).toHaveValue(
    "First keyboard issue",
  );
  const complete = page.getByRole("button", { name: "Mark complete" });
  await complete.focus();
  await complete.press("Space");
  await expect(
    page.getByRole("button", { name: "Reopen issue" }),
  ).toBeFocused();
});

test("leaves modal keyboard handling and focus restoration to the dialog", async ({
  page,
}) => {
  await page.goto("/projects");
  const create = page.getByRole("button", { name: "Create project" });
  await create.click();
  const modal = page.getByRole("dialog");
  const name = modal.getByRole("textbox", { name: "Project name" });
  await expect(name).toBeFocused();
  await name.press("Alt+Shift+KeyN");
  await expect(modal).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  await name.press("Escape");
  await expect(modal).toBeHidden();
  await expect(create).toBeFocused();
});

test("moves issues on the board by keyboard and by dragging", async ({
  page,
}) => {
  await seedIssues(page, [
    { title: "Sketch layout", priority: "high", projectId: "project-1" },
    { title: "Order paint", status: "in_progress" },
    { title: "Hang lights" },
  ]);
  await page.goto("/issues?priority=high");
  await page.getByRole("link", { name: "Board view" }).click();
  // The board keeps the list's filters.
  await expect(page).toHaveURL(/\/issues\/board\?priority=high$/);
  const column = (name: string) =>
    page.getByRole("region", { name: new RegExp(`^${name}`) });
  await expect(column("To Do").getByRole("listitem")).toHaveCount(1);
  await expect(column("To Do")).toContainText("High");
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(column("To Do").getByRole("listitem")).toHaveCount(2);
  await expect(column("In Progress").getByRole("listitem")).toHaveCount(1);
  await expect(column("To Do").getByRole("heading")).toContainText("2");

  // Keyboard: the Move menu.
  const move = page.getByRole("button", { name: "Move ISS-1: Sketch layout" });
  await move.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Move ISS-1 to" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(move).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Blocked" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Moved ISS-1 to Blocked.")).toBeVisible();
  await expect(
    column("Blocked").getByRole("link", { name: "Sketch layout" }),
  ).toBeVisible();
  // Focus follows the card into its new column.
  await expect(move).toBeFocused();

  // Mouse: drag and drop.
  await column("To Do")
    .getByRole("listitem")
    .filter({ hasText: "Hang lights" })
    .dragTo(column("Done"));
  await expect(page.getByText("Moved ISS-3 to Done.")).toBeVisible();
  await expect(
    column("Done").getByRole("link", { name: "Hang lights" }),
  ).toBeVisible();
  await expect(column("To Do").getByText("No issues")).toBeVisible();

  // The list shows the same state.
  await page.getByRole("link", { name: "List view" }).click();
  await page.getByRole("button", { name: /^All/ }).click();
  const row = (title: string) =>
    page.getByRole("listitem").filter({ hasText: title });
  await expect(row("Sketch layout").getByText("Blocked")).toBeVisible();
  await expect(row("Hang lights").getByText("Done")).toBeVisible();
});

test("restores a card when a move fails and ignores late replies to older moves", async ({
  page,
}) => {
  await seedIssues(page, [{ title: "Water plants" }]);
  await page.goto("/issues/board");
  const column = (name: string) =>
    page.getByRole("region", { name: new RegExp(`^${name}`) });
  const card = (name: string) =>
    column(name).getByRole("link", { name: "Water plants" });
  const move = page.getByRole("button", { name: "Move ISS-1: Water plants" });
  const moveTo = async (status: string) => {
    await move.click();
    await page
      .getByRole("menu", { name: "Move ISS-1 to" })
      .getByRole("menuitem", { name: status })
      .click();
  };

  // A rejected move puts the card back with an explanation.
  await dispatch(page, "fail-once", "change_issue_status");
  await moveTo("Done");
  await expect(page.getByRole("alert")).toContainText(
    "Could not move ISS-1 to Done. It is back in To Do.",
  );
  await expect(card("To Do")).toBeVisible();
  await expect(move).toBeFocused();

  // Two quick moves: the first is held and then fails, the second succeeds.
  // The first reply arrives late and must not undo the newer move.
  await dispatch(page, "hold-command", "change_issue_status");
  await dispatch(page, "fail-once", "change_issue_status");
  await moveTo("In Progress");
  await expect(card("In Progress")).toBeVisible();
  await moveTo("Blocked");
  await expect(card("Blocked")).toBeVisible();
  await dispatch(page, "release-change_issue_status");
  await expect(page.getByText("Moved ISS-1 to Blocked.")).toBeVisible();
  await expect(card("Blocked")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("bounds a large board and loads more cards per column", async ({
  page,
}) => {
  await seedIssues(
    page,
    Array.from({ length: 300 }, (_, index) => ({
      title: `Card ${index + 1}`,
      status: index % 3 === 0 ? ("done" as const) : ("todo" as const),
      labelIds: [],
    })),
  );
  await page.goto("/issues/board");
  const todo = page.getByRole("region", { name: /^To Do/ });
  await expect(todo.getByRole("heading")).toContainText("200");
  await expect(todo.getByRole("listitem")).toHaveCount(50);
  await expect(
    page.getByRole("region", { name: /^Done/ }).getByRole("listitem"),
  ).toHaveCount(50);
  await expect(page.locator(".board-card")).toHaveCount(100);
  await todo.getByRole("button", { name: "Show more in To Do (150)" }).click();
  await expect(todo.getByRole("listitem")).toHaveCount(100);
  const keys = await todo.locator(".issue-key").allTextContents();
  expect(new Set(keys).size).toBe(100);
});

test.describe("Today and Upcoming", () => {
  // A fixed zone with a daylight-saving change on 2026-11-01.
  // Clock times below carry explicit offsets, because the test process may
  // run in a different zone from the page.
  test.use({ timezoneId: "America/New_York" });

  const seeds = [
    { title: "Renew passport", dueDate: "2026-11-10", projectId: "project-1" },
    { title: "Pay rent", dueDate: "2026-11-16", priority: "high" as const },
    { title: "Send invites", dueDate: "2026-11-17", projectId: "project-1" },
    { title: "Pick up frame", dueDate: "2026-11-20" },
    { title: "Book flights", dueDate: "2026-12-25" },
    { title: "Someday idea" },
    { title: "Already filed", dueDate: "2026-11-15", status: "done" as const },
  ];

  test("shows overdue and today, groups upcoming by date, and explains undated issues", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00-05:00"));
    await seedIssues(page, seeds);
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Today" })
      .click();
    const group = (name: string) =>
      page.getByRole("region", { name: new RegExp(`^${name}`) });
    await expect(group("Overdue").getByRole("link")).toHaveText([
      "Renew passport",
    ]);
    await expect(group("Overdue")).toContainText("Overdue, due");
    await expect(group("Today").getByRole("link")).toHaveText(["Pay rent"]);
    // Closed and undated issues are not listed.
    await expect(page.getByText("Already filed")).toHaveCount(0);
    await expect(page.getByText("Someday idea")).toHaveCount(0);
    await expect(
      page.getByText("1 open issue has no due date and is not shown here."),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Review issues without a due date" }),
    ).toHaveAttribute("href", "/issues?due=none");

    await page.getByRole("link", { name: "Upcoming" }).click();
    await expect(page).toHaveURL(/\/today\/upcoming$/);
    const headings = page.locator(".task-group h2");
    await expect(headings).toHaveCount(3);
    await expect(headings.nth(0)).toContainText("Tomorrow");
    await expect(headings.nth(1)).toContainText("Friday");
    await expect(headings.nth(2)).toContainText("Dec");
    await expect(group("Tomorrow").getByRole("link")).toHaveText([
      "Send invites",
    ]);

    // Optional project grouping, with the Inbox last.
    // The checkbox follows the URL, which updates just after the click.
    await page.getByLabel("Group by project").click();
    await expect(page.getByLabel("Group by project")).toBeChecked();
    await expect(page).toHaveURL(/group=project/);
    await expect(headings).toHaveCount(2);
    await expect(headings.nth(0)).toContainText("Studio launch");
    await expect(headings.nth(1)).toContainText("Inbox");
    await page.getByRole("link", { name: "Today", exact: true }).last().click();
    await expect(page).toHaveURL(/\/today\?group=project$/);
  });

  test("loads the last open issue after completing a row on the first page", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00-05:00"));
    await seedIssues(
      page,
      Array.from({ length: 101 }, (_, index) => ({
        title: `Paged task ${index + 1}`,
        dueDate: "2026-11-16",
      })),
    );
    await page.goto("/today");
    await expect(page.getByText("Showing 100 of 101")).toBeVisible();
    await page.getByRole("button", { name: /^Complete ISS-1:/ }).click();
    await expect(page.getByText("Showing 99 of 100")).toBeVisible();
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(
      page.getByRole("link", { name: "Paged task 101" }),
    ).toBeVisible();
  });

  test("completes in place and reschedules with immediate updates", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00-05:00"));
    await seedIssues(page, seeds);
    await page.goto("/today");

    // Completion keeps the row in place until the view reloads.
    await page
      .getByRole("button", { name: "Complete ISS-2: Pay rent" })
      .click();
    await expect(page.getByText("ISS-2 completed.")).toBeVisible();
    const rent = page.getByRole("listitem").filter({ hasText: "Pay rent" });
    await expect(rent.getByText("Completed")).toBeVisible();
    await rent.getByRole("button", { name: "Reopen ISS-2: Pay rent" }).click();
    await expect(page.getByText("ISS-2 reopened.")).toBeVisible();

    // Rescheduling an overdue issue to tomorrow moves it to Upcoming.
    await page.getByRole("button", { name: "Move ISS-1 to tomorrow" }).click();
    await expect(
      page.getByText("ISS-1 is now due tomorrow and moved to Upcoming."),
    ).toBeVisible();
    // The task list drops it. The schedule's Coming up now lists its new
    // deadline, because it re-reads when an issue changes.
    await expect(
      page.getByRole("link", { name: "Renew passport", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Deadline: ISS-1 Renew passport" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Complete ISS-2: Pay rent" }),
    ).toBeFocused();

    // A rejected reschedule puts the issue back.
    await dispatch(page, "fail-once", "set_issue_due_date");
    await page.getByRole("button", { name: "Move ISS-2 to tomorrow" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Could not reschedule ISS-2.",
    );
    await expect(page.getByRole("link", { name: "Pay rent" })).toBeVisible();

    await page.getByRole("link", { name: "Upcoming" }).click();
    const tomorrow = page.getByRole("region", { name: /^Tomorrow/ });
    await expect(tomorrow.getByRole("link")).toHaveText([
      "Renew passport",
      "Send invites",
    ]);
    // Typing a date commits on Enter, keeping the same issue.
    const date = page.getByLabel("Due date for ISS-3");
    await date.fill("2026-11-16");
    await date.press("Enter");
    await expect(
      page.getByText("ISS-3 is now due today and moved to Today."),
    ).toBeVisible();
    await page.getByRole("link", { name: "Today", exact: true }).last().click();
    await expect(
      page.getByRole("region", { name: /^Today/ }).getByRole("link"),
    ).toHaveText(["Pay rent", "Send invites"]);
    await page.getByRole("link", { name: "Send invites" }).click();
    await expect(page.getByText("ISS-3", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Due date", { exact: true })).toHaveValue(
      "2026-11-16",
    );
  });

  test("refreshes at local midnight, across daylight saving, and on resume", async ({
    page,
  }) => {
    // 2026-11-01 is 25 hours long in New York.
    await page.clock.install({ time: new Date("2026-11-01T23:59:00-05:00") });
    await seedIssues(page, [
      { title: "Return library books", dueDate: "2026-11-02" },
    ]);
    await page.goto("/today");
    await expect(
      page.getByRole("heading", { name: "Nothing due today" }),
    ).toBeVisible();

    await page.clock.runFor(2 * 60 * 1000);
    await expect(
      page
        .getByRole("region", { name: /^Today/ })
        .getByRole("link", { name: "Return library books" }),
    ).toBeVisible();

    // After sleeping past several midnights, focus brings the view up to date.
    await page.clock.setSystemTime(new Date("2026-11-04T09:00:00-05:00"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page
        .getByRole("region", { name: /^Overdue/ })
        .getByRole("link", { name: "Return library books" }),
    ).toBeVisible();
  });
});

test.describe("Calendar", () => {
  // A six-week grid needs a tall window: native drag and drop in tests
  // fails for targets at the edge of the viewport.
  test.use({
    timezoneId: "America/New_York",
    viewport: { width: 1280, height: 1100 },
  });

  test("shows dated issues, moves by keyboard, reschedules, creates, and filters", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00-05:00"));
    await seedIssues(page, [
      { title: "Hang posters", dueDate: "2026-11-16", projectId: "project-1" },
      { title: "Buy frames", dueDate: "2026-11-20" },
      { title: "Old errand", dueDate: "2026-11-02", status: "done" },
      { title: "Winter prep", dueDate: "2026-12-03" },
      { title: "No date yet" },
    ]);
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Calendar" })
      .click();
    // The calendar opens on Week; issues are on the month grid.
    await page.getByRole("button", { name: "Month", exact: true }).click();
    const grid = page.getByRole("table", { name: "November 2026" });
    await expect(grid).toBeVisible();
    const today = grid.getByRole("button", {
      name: /^Monday, November 16, 2026/,
    });
    await expect(today).toHaveAttribute("aria-current", "date");
    await expect(today).toHaveAttribute("aria-pressed", "true");
    const panel = page.getByRole("region", {
      name: "Monday, November 16, 2026",
    });
    await expect(
      panel.getByRole("link", { name: "Hang posters" }),
    ).toBeVisible();
    await expect(grid.getByText("Buy frames")).toBeVisible();
    // Closed and undated issues are hidden unless asked for.
    await expect(grid.getByText("Old errand")).toHaveCount(0);
    await expect(page.getByText("No date yet")).toHaveCount(0);
    await page.getByLabel("Show closed issues").click();
    await expect(grid.getByText("Old errand")).toBeVisible();

    // Arrow keys move between days, Page Down to the next month.
    await today.focus();
    for (let step = 0; step < 4; step++)
      await page.keyboard.press("ArrowRight");
    const friday = grid.getByRole("button", {
      name: /^Friday, November 20, 2026, 1 issue/,
    });
    await expect(friday).toBeFocused();
    await expect(
      page.getByRole("region", { name: "Friday, November 20, 2026" }),
    ).toContainText("Buy frames");
    await page.keyboard.press("PageDown");
    const december = page.getByRole("table", { name: "December 2026" });
    await expect(
      december.getByRole("button", { name: /^Sunday, December 20, 2026/ }),
    ).toBeFocused();
    await expect(december.getByText("Winter prep")).toBeVisible();
    await page.keyboard.press("PageUp");
    await expect(friday).toBeFocused();

    // Reschedule by typing a date.
    const date = page.getByLabel("Due date for ISS-2");
    await date.fill("2026-11-18");
    await date.press("Enter");
    await expect(
      page.getByText("ISS-2 is now due Wednesday, November 18, 2026."),
    ).toBeVisible();
    await expect(
      grid.getByRole("button", {
        name: /^Wednesday, November 18, 2026, 1 issue/,
      }),
    ).toBeVisible();

    // Reschedule by dragging, keeping the same issue.
    await grid
      .locator(".calendar-chip")
      .filter({ hasText: "Hang posters" })
      .dragTo(
        grid.getByRole("cell").filter({
          has: page.getByRole("button", { name: /^Tuesday, November 17/ }),
        }),
      );
    await expect(
      page.getByText("ISS-1 is now due Tuesday, November 17, 2026."),
    ).toBeVisible();

    // A rejected reschedule leaves the issue where it was.
    await dispatch(page, "fail-once", "set_issue_due_date");
    await grid
      .locator(".calendar-chip")
      .filter({ hasText: "Hang posters" })
      .dragTo(
        grid.getByRole("cell").filter({
          has: page.getByRole("button", { name: /^Thursday, November 19/ }),
        }),
      );
    await expect(page.getByRole("alert")).toContainText(
      "Could not reschedule ISS-1. It is still due Tuesday, November 17, 2026.",
    );
    await expect(
      grid.getByRole("button", {
        name: /^Tuesday, November 17, 2026, 1 issue/,
      }),
    ).toBeVisible();

    // Create on a chosen day.
    await grid
      .getByRole("button", { name: /^Wednesday, November 25, 2026/ })
      .click();
    await page.getByLabel("New issue on this day").fill("Bake pies");
    await page.getByRole("button", { name: "Add issue" }).click();
    await expect(
      page.getByText("Created ISS-6, due Wednesday, November 25, 2026."),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Wednesday, November 25, 2026" }),
    ).toContainText("Bake pies");

    // Project filter.
    await page.getByLabel("Project").selectOption("project-1");
    await expect(grid.getByText("Hang posters")).toBeVisible();
    await expect(grid.getByText("Buy frames")).toHaveCount(0);

    // Open an issue from the calendar.
    await grid.getByRole("button", { name: /^Tuesday, November 17/ }).click();
    await page
      .getByRole("region", { name: "Tuesday, November 17, 2026" })
      .getByRole("link", { name: "Hang posters" })
      .click();
    await expect(page.getByLabel("Issue title")).toHaveValue("Hang posters");
    await expect(page.getByLabel("Due date", { exact: true })).toHaveValue(
      "2026-11-17",
    );
  });
});

test.describe("Recurring issues", () => {
  test.use({ timezoneId: "America/New_York" });

  test("repeats an issue, creates the next occurrence on completion, and stops", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00-05:00"));
    await seedIssues(page, [
      { title: "Water ferns", dueDate: "2026-11-16" },
      { title: "Someday" },
    ]);
    await page.goto("/issues");

    // A repeat needs a due date.
    await page.getByRole("link", { name: "Someday" }).click();
    await expect(page.getByLabel("Issue title")).toHaveValue("Someday");
    const repeat = page.getByRole("group", { name: "Repeat" });
    await repeat.getByLabel("Frequency").selectOption("daily");
    await expect(
      repeat.getByText(
        "Set a due date first. Repeats start from the due date.",
      ),
    ).toBeVisible();
    await page.getByRole("link", { name: "All issues" }).click();

    await page.getByRole("link", { name: "Water ferns" }).click();
    await expect(page.getByLabel("Issue title")).toHaveValue("Water ferns");
    await expect(repeat.getByText("Does not repeat").first()).toBeVisible();
    await repeat.getByLabel("Frequency").selectOption("weekly");
    await repeat.getByLabel("Every").fill("2");
    await repeat.getByRole("button", { name: "Save repeat" }).click();
    await expect(page.getByText("Repeat saved.")).toBeVisible();
    await expect(repeat.getByText("Repeats every 2 weeks")).toBeVisible();

    // Completing creates the next occurrence, two weeks after the anchor.
    await page.getByRole("button", { name: "Mark complete" }).click();
    await expect(page.getByText("Issue completed.")).toBeVisible();
    await expect(repeat.getByText(/Next occurrence:/)).toContainText("ISS-3");
    await repeat.getByRole("link", { name: "ISS-3" }).click();
    await expect(page.getByLabel("Issue title")).toHaveValue("Water ferns");
    await expect(page.getByLabel("Due date", { exact: true })).toHaveValue(
      "2026-11-30",
    );

    // The new occurrence shows as repeating in the list.
    await page.getByRole("link", { name: "All issues" }).click();
    const row = page.getByRole("listitem").filter({ hasText: "ISS-3" });
    await expect(row.getByText("Repeats")).toBeAttached();

    // Stopping keeps the occurrence and creates no more.
    await row.getByRole("link", { name: "Water ferns" }).click();
    await repeat.getByLabel("Frequency").selectOption("");
    await repeat.getByRole("button", { name: "Stop repeating" }).click();
    await expect(page.getByText("This issue no longer repeats.")).toBeVisible();
    await expect(repeat.getByText("Stopped repeating")).toBeVisible();
    await page.getByRole("button", { name: "Mark complete" }).click();
    await expect(page.getByText("Issue completed.")).toBeVisible();
    await page.getByRole("link", { name: "All issues" }).click();
    await page.getByRole("button", { name: /^All/ }).click();
    await expect(
      page.getByRole("list", { name: "All issues" }).getByRole("listitem"),
    ).toHaveCount(3);
  });
});

test.describe("Saved views", () => {
  test.use({ timezoneId: "America/New_York" });

  test("saves, opens from the sidebar, updates, renames, and deletes a view", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00-05:00"));
    await seedIssues(page, [
      { title: "Late and urgent", priority: "urgent", dueDate: "2026-11-10" },
      { title: "Late but low", priority: "low", dueDate: "2026-11-09" },
      { title: "Not due", priority: "urgent" },
    ]);
    await page.goto("/issues?priority=urgent&due=overdue");
    const titles = page
      .getByRole("list", { name: "Open issues" })
      .getByRole("link", { name: /^(Late and urgent|Late but low|Not due)$/ });
    await expect(titles).toHaveText(["Late and urgent"]);

    await page.getByRole("button", { name: "Save view" }).click();
    await expect(page.getByLabel("View name")).toBeFocused();
    await page.getByLabel("View name").fill("Urgent overdue");
    await page.getByLabel("View name").press("Enter");
    await expect(page.getByText("Saved view Urgent overdue.")).toBeVisible();
    await expect(page).toHaveURL(/view=view-1/);
    const sidebar = page.getByRole("region", { name: "Saved views" });
    const link = sidebar.getByRole("link", { name: "Urgent overdue" });
    await expect(link).toHaveAttribute("aria-current", "page");

    // Opening the view restores its filters, with the due rule still relative.
    // Navigate inside the app: a reload would reset the in-memory IPC state.
    await page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Home" })
      .click();
    await page
      .getByRole("region", { name: "Saved views" })
      .getByRole("link", { name: "Urgent overdue" })
      .click();
    await expect(page).toHaveURL(/due=overdue/);
    await expect(titles).toHaveText(["Late and urgent"]);
    await expect(page.getByText("View: Urgent overdue")).toBeVisible();

    // Edit the filters and save them back.
    const update = page.getByRole("button", { name: "Update view" });
    await expect(update).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("combobox", { name: /^Priority/ }).selectOption("");
    await expect(page.getByText("(changed)")).toBeVisible();
    await expect(titles).toHaveText(["Late but low", "Late and urgent"]);
    await update.click();
    await expect(page.getByText("Updated view Urgent overdue.")).toBeVisible();
    await expect(page.getByText("(changed)")).toHaveCount(0);

    // Rename, then delete.
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("New view name").fill("Overdue");
    await page.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByText("Renamed the view to Overdue.")).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Overdue" })).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.getByText("Delete Overdue? This removes only the saved view"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Delete view" }).click();
    await expect(page.getByText("Deleted view Overdue.")).toBeVisible();
    await expect(sidebar).toHaveCount(0);
    await expect(page).not.toHaveURL(/view=/);
    // The issues are untouched.
    await expect(titles).toHaveText(["Late but low", "Late and urgent"]);
  });

  test("reports references that no longer exist and can drop them", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.assign(window, {
        __seedViews: [
          {
            id: "view-stale",
            name: "Stale view",
            createdAt: "2026-11-01T00:00:00Z",
            updatedAt: "2026-11-01T00:00:00Z",
            config: {
              version: 1,
              view: "board",
              filters: {
                state: "",
                text: "",
                status: "",
                priority: "",
                project: "project-gone",
                due: "",
                labels: ["label-gone"],
                labelMatch: "",
                milestone: "",
                sort: "",
                direction: "",
              },
            },
          },
        ],
      });
    });
    await seedIssues(page, [{ title: "Visible issue" }]);
    await page.goto("/");
    await page
      .getByRole("region", { name: "Saved views" })
      .getByRole("link", { name: "Stale view" })
      .click();
    await expect(page).toHaveURL(/\/issues\/board\?/);
    await expect(page.getByRole("alert")).toContainText(
      "This view refers to a project and a label that are no longer available",
    );
    await page
      .getByRole("button", { name: "Remove unavailable filters" })
      .click();
    await expect(
      page.getByText(
        "Removed the unavailable filters. Update the view to keep this.",
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(/view=view-stale/);
    await expect(
      page.getByRole("link", { name: "Visible issue" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Update view" }).click();
    await expect(page.getByText("Updated view Stale view.")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

test("links documents to issues and projects and navigates both ways", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __seedDocuments: ["Launch brief", "Venue notes", "Unrelated"],
    });
  });
  await seedIssues(page, [
    { title: "Plan launch", projectId: "project-1" },
    { title: "Book venue", projectId: "project-1" },
  ]);
  await page.goto("/issues");
  await page.getByRole("link", { name: "Book venue" }).click();
  await expect(page.getByLabel("Issue title")).toHaveValue("Book venue");
  const linkedDocuments = page.getByRole("region", {
    name: "Linked documents",
  });
  await expect(
    linkedDocuments.getByText("No documents linked yet."),
  ).toBeVisible();
  await linkedDocuments
    .getByLabel("Link a document")
    .selectOption({ label: "Venue notes" });
  await linkedDocuments
    .getByRole("button", { name: "Link", exact: true })
    .click();
  await expect(page.getByText("Linked Venue notes.")).toBeVisible();

  // To the document and back.
  await linkedDocuments.getByRole("link", { name: "Venue notes" }).click();
  await expect(page).toHaveURL(/\/documents\?doc=doc-2$/);
  await expect(page.getByLabel("Document title")).toHaveValue("Venue notes");
  const usage = page.getByRole("region", { name: "Linked from" });
  await expect(
    usage.getByRole("link", { name: "ISS-2: Book venue" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to ISS-2" }).click();
  await expect(page.getByLabel("Issue title")).toHaveValue("Book venue");

  // The project shows its own links separately from its issues' links.
  await page.getByRole("link", { name: "Open project Studio launch" }).click();
  await expect(
    page.getByRole("heading", { name: "Studio launch", level: 1 }),
  ).toBeVisible();
  const projectDocs = page.getByRole("region", {
    name: "Documents",
    exact: true,
  });
  await projectDocs
    .getByLabel("Link a document")
    .selectOption({ label: "Launch brief" });
  await projectDocs.getByRole("button", { name: "Link", exact: true }).click();
  await expect(page.getByText("Linked Launch brief.")).toBeVisible();
  const inherited = page.getByRole("region", {
    name: "From this project's issues",
  });
  await expect(
    inherited.getByRole("link", { name: "Venue notes" }),
  ).toBeVisible();
  await expect(
    inherited.getByRole("link", { name: "ISS-2: Book venue" }),
  ).toBeVisible();
  await expect(inherited.getByText("Launch brief")).toHaveCount(0);

  // Unlinking removes only the link.
  await projectDocs
    .getByRole("button", { name: "Unlink Launch brief" })
    .click();
  await expect(
    page.getByText("Unlinked Launch brief. The document itself is unchanged."),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Documents" })
    .click();
  await expect(
    page.getByRole("button", { name: "Launch brief" }),
  ).toBeVisible();

  // A link to a document that no longer exists says so.
  await page.goto("/documents?doc=doc-missing");
  await expect(page.getByRole("alert")).toHaveText(
    "Could not open this document.",
  );
});

test.describe("Project overview", () => {
  test.use({ timezoneId: "America/New_York" });

  test("answers what is underway, late, and next, with links to the lists", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00-05:00"));
    await page.addInitScript(() => {
      Object.assign(window, { __seedDocuments: [] });
    });
    await seedIssues(page, [
      { title: "Print posters", projectId: "project-1", dueDate: "2026-11-10" },
      {
        title: "Book venue",
        projectId: "project-1",
        dueDate: "2026-11-18",
        status: "in_progress",
      },
      {
        title: "Order chairs",
        projectId: "project-1",
        status: "done",
        completedAt: "2026-11-15T12:00:00.000Z",
      },
      { title: "Cancelled idea", projectId: "project-1", status: "canceled" },
      { title: "Write invite", projectId: "project-1" },
      { title: "Other project", projectId: "project-2", status: "done" },
    ]);
    await page.goto("/projects/project-1");
    const overview = page.getByRole("region", { name: "Overview" });
    // 1 done of 4 non-canceled issues.
    await expect(overview.getByText("25%")).toBeVisible();
    await expect(
      overview.getByText("1 of 4 done, canceled issues not counted"),
    ).toBeVisible();
    await expect(overview.getByRole("link", { name: /^Open 3/ })).toBeVisible();
    const bars = overview.getByRole("region", { name: "Issues by status" });
    await expect(
      bars.getByRole("link", { name: "Done 1 issue" }),
    ).toBeVisible();
    await expect(
      bars.getByRole("link", { name: "In Progress 1 issue" }),
    ).toBeVisible();
    await expect(
      overview
        .getByRole("region", { name: "Overdue" })
        .getByRole("link", { name: "ISS-1: Print posters" }),
    ).toBeVisible();
    await expect(
      overview
        .getByRole("region", { name: "Coming up" })
        .getByRole("link", { name: "ISS-2: Book venue" }),
    ).toBeVisible();
    await expect(
      overview.getByRole("link", { name: "1 open issue has no due date" }),
    ).toBeVisible();
    const activity = overview.getByRole("region", { name: "Recent activity" });
    await expect(
      activity.getByText("Completed", { exact: true }),
    ).toBeVisible();

    // Metrics open the matching list.
    await overview.getByRole("link", { name: /^Overdue 1/ }).click();
    await expect(page).toHaveURL(/\/projects\/project-1\/issues\?due=overdue$/);
    await expect(
      page.getByRole("list", { name: "Open issues" }).getByRole("listitem"),
    ).toHaveCount(1);
    await page.goBack();
    await page
      .getByRole("region", { name: "Issues by status" })
      .getByRole("link", { name: "Done 1 issue" })
      .click();
    await expect(page).toHaveURL(/state=all&status=done/);
    const list = page.getByRole("list", { name: "All issues" });
    await expect(
      list.getByRole("link", { name: "Order chairs" }),
    ).toBeVisible();
    await expect(list.getByRole("link", { name: "Other project" })).toHaveCount(
      0,
    );
  });

  test("shows a calm empty state for a project with no issues", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.assign(window, { __seedDocuments: [] });
    });
    await seedIssues(page, []);
    await page.goto("/projects/project-2");
    const overview = page.getByRole("region", { name: "Overview" });
    await expect(overview.getByText("No issues yet").first()).toBeVisible();
    await expect(overview.getByText("Nothing overdue.")).toBeVisible();
    await expect(overview.getByText("No activity yet.")).toBeVisible();
  });
});

test("searches the workspace from the header with keyboard navigation", async ({
  page,
}) => {
  await seedIssues(page, [
    { title: "Launch party", status: "done" },
    { title: "Print launch posters", projectId: "project-1" },
    { title: "Water plants" },
  ]);
  await page.goto("/issues");
  await expect(page.getByRole("link", { name: "Water plants" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+K");
  const dialog = page.getByRole("dialog", { name: "Search the workspace" });
  const input = dialog.getByRole("combobox", {
    name: "Search projects, issues, documents, and milestones",
  });
  await expect(input).toBeFocused();
  await expect(dialog.getByRole("status")).toContainText("Type to search");

  await input.fill("launch");
  const options = dialog.getByRole("option");
  await expect(options).toHaveText([
    /Studio launch/,
    /ISS-2: Print launch posters/,
    /ISS-1: Launch party/,
  ]);
  await expect(
    dialog.getByRole("group", { name: /Issues/ }).getByRole("option"),
  ).toHaveCount(2);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", "issue-seed-2");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Issue title")).toHaveValue(
    "Print launch posters",
  );

  // Issue numbers jump straight to the issue.
  await page.getByRole("button", { name: "Search" }).click();
  await input.fill("ISS-3");
  await expect(options.first()).toHaveText(/ISS-3: Water plants/);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Issue title")).toHaveValue("Water plants");

  // No results, then a slow stale reply that must not replace newer results.
  await page.keyboard.press("ControlOrMeta+K");
  await input.fill("zebra");
  await expect(dialog.getByRole("status")).toHaveText(
    "No workspace results match “zebra”.",
  );
  await dispatch(page, "hold-command", "search_workspace");
  await input.fill("water");
  await expect(dialog.getByRole("status")).toHaveText("Searching…");
  // Let the debounce pass so the "water" request is in flight and held.
  await page.waitForTimeout(300);
  await input.fill("launch");
  await expect(options).toHaveCount(3);
  await dispatch(page, "release-search_workspace");
  await page.waitForTimeout(50);
  await expect(options).toHaveCount(3);
  await expect(options.first()).toHaveText(/Studio launch/);

  // Escape closes and returns focus to the Search button.
  await page.getByRole("option").first().waitFor();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Search" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Search" })).toBeFocused();
});

test("reaches a capped group's See all option with the keyboard", async ({
  page,
}) => {
  await seedIssues(
    page,
    Array.from({ length: 10 }, (_, index) => ({ title: `Fern ${index + 1}` })),
  );
  await page.goto("/issues");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search the workspace" });
  await dialog.getByRole("combobox").fill("fern");
  const issues = dialog.getByRole("group", { name: /Issues/ });
  // Eight results, then See all as the group's last option.
  await expect(issues.getByRole("option")).toHaveCount(9);
  await page.keyboard.press("End");
  await expect(
    issues.getByRole("option", { name: "See all 10 matching issues" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/issues\?state=all&q=fern$/);
  await expect(page.getByRole("link", { name: "Fern 10" })).toBeVisible();
});

test("archives, restores, and permanently deletes an issue with confirmation", async ({
  page,
}) => {
  await seedIssues(page, [
    { title: "Old idea", status: "done" },
    { title: "Child step" },
    { title: "Keep me" },
  ]);
  // Make "Child step" a sub-issue of "Old idea".
  await page.goto("/issues/seed-1");
  await page.getByRole("button", { name: "Add relationship" }).click();
  const relationships = page.getByRole("region", { name: "Relationships" });
  await relationships.getByLabel("Relationship").selectOption("child");
  await relationships
    .getByRole("combobox", { name: "Issue", exact: true })
    .selectOption("seed-2");
  await relationships
    .getByRole("button", { name: "Save relationship" })
    .click();
  await expect(
    relationships.getByRole("link", { name: /Child step/ }),
  ).toBeVisible();

  // Archive: the issue keeps its status and leaves the default list.
  await page.getByRole("button", { name: "Archive issue" }).click();
  await expect(page.getByText("This issue is archived.")).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Status/ })).toHaveValue(
    "done",
  );
  await page.getByRole("link", { name: "All issues" }).click();
  await page.getByRole("button", { name: /^All/ }).click();
  const list = page.getByRole("list", { name: "All issues" });
  // Wait for the All list itself, so the next check is not vacuous.
  await expect(list.getByRole("link", { name: "Keep me" })).toBeVisible();
  await expect(list.getByRole("link", { name: "Old idea" })).toHaveCount(0);
  await page.getByRole("combobox", { name: /^Archived/ }).selectOption("only");
  await expect(list.getByRole("link", { name: "Old idea" })).toBeVisible();
  await expect(list.getByText("Archived", { exact: true })).toBeVisible();

  // The sub-issue still shows its archived parent.
  await page.getByRole("combobox", { name: /^Archived/ }).selectOption("");
  await list.getByRole("link", { name: "Child step" }).click();
  await expect(
    page.getByRole("region", { name: "Relationships" }).getByText("Archived"),
  ).toBeVisible();
  await page.getByRole("link", { name: "All issues" }).click();

  // Restore brings it back exactly.
  await page.getByRole("combobox", { name: /^Archived/ }).selectOption("only");
  await list.getByRole("link", { name: "Old idea" }).click();
  await page.getByRole("button", { name: "Restore issue" }).click();
  await expect(page.getByText("Issue restored.")).toBeVisible();
  await expect(page.getByText("This issue is archived.")).toHaveCount(0);

  // Deletion is offered only when archived, and blocked by sub-issues.
  await page.getByRole("button", { name: "Archive issue" }).click();
  await page.getByRole("button", { name: "Delete permanently…" }).click();
  const panel = page.getByRole("region", { name: "Delete ISS-1 permanently" });
  await expect(panel.getByRole("alert")).toContainText(
    "It has 1 sub-issue. Remove or reassign them first.",
  );
  await panel.getByLabel("Type ISS-1 to confirm").fill("ISS-1");
  await expect(
    panel.getByRole("button", { name: "Delete ISS-1" }),
  ).toHaveAttribute("aria-disabled", "true");
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByRole("button", { name: "Restore issue" }),
  ).toBeFocused();

  // Delete a leaf issue with the typed key.
  await page.getByRole("link", { name: "All issues" }).click();
  await page.getByRole("combobox", { name: /^Archived/ }).selectOption("");
  await list.getByRole("link", { name: "Keep me" }).click();
  await page.getByRole("button", { name: "Archive issue" }).click();
  await page.getByRole("button", { name: "Delete permanently…" }).click();
  const leaf = page.getByRole("region", { name: "Delete ISS-3 permanently" });
  await expect(leaf.getByText("It has no links to remove.")).toBeVisible();
  const confirm = leaf.getByLabel("Type ISS-3 to confirm");
  await expect(confirm).toBeFocused();
  await confirm.fill("ISS-2");
  await expect(
    leaf.getByRole("button", { name: "Delete ISS-3" }),
  ).toHaveAttribute("aria-disabled", "true");
  await confirm.fill("iss-3");
  await leaf.getByRole("button", { name: "Delete ISS-3" }).click();
  await expect(page).toHaveURL(/\/issues\?archived=only$/);
  await expect(page.getByRole("link", { name: "Keep me" })).toHaveCount(0);
});

test("exports filtered issues as CSV and imports a project file after a preview", async ({
  page,
}) => {
  await seedIssues(page, [
    { title: "Existing one" },
    { title: "Existing two", priority: "high" },
  ]);
  await page.goto("/issues?priority=high&q=two");
  await expect(page.getByRole("link", { name: "Existing two" })).toBeVisible();

  // CSV export sends the list's own query, so it follows the filters.
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(
    page.getByText("Exported 2 issues to /Exports/issues.csv."),
  ).toBeVisible();
  const sent = await page.evaluate(
    () =>
      (
        window as {
          __lastExport?: { args: { query: Record<string, unknown> } };
        }
      ).__lastExport?.args.query,
  );
  expect(sent).toMatchObject({ text: "two", priorities: ["high"] });
  await page.evaluate(() => Object.assign(window, { __cancelSave: true }));
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(page.getByText("Export canceled.")).toBeVisible();
  await page.evaluate(() => Object.assign(window, { __cancelSave: false }));

  // JSON export from Settings. The mock lives in the page, so the rest of
  // the test navigates inside the app instead of reloading.
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await nav.getByRole("link", { name: "Settings" }).click();
  const data = page.getByRole("region", { name: "Data" });
  await data.getByRole("button", { name: "Export projects" }).click();
  await expect(
    data.getByText("Exported 2 projects and issues to /Exports/projects.json."),
  ).toBeVisible();

  // A file in another format is rejected with the reason, before any write.
  const file = data.getByLabel("Choose an export file");
  await file.setInputFiles({
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "other" })),
  });
  await expect(data.getByRole("alert")).toContainText(
    "This is not an Unhollowed 2 project export.",
  );
  await expect(data.getByRole("button", { name: "Import" })).toHaveCount(0);

  // A valid file shows a preview, and nothing is added until confirmed.
  const content = JSON.stringify({
    format: "unhollowed-2/projects",
    issues: [{ title: "Copied one" }, { title: "Copied two" }],
  });
  await file.setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(content),
  });
  const preview = data.getByRole("group", {
    name: "Importing backup.json will add",
  });
  await expect(preview.getByText("2 issues")).toBeVisible();
  await expect(preview.getByText("Uses existing labels: Bug")).toBeVisible();
  await expect(
    preview.getByText("Sets a completion time on 1 done issue that had none"),
  ).toBeVisible();
  await expect(preview.getByRole("button", { name: "Import" })).toBeFocused();
  await preview.getByText("New issue keys").click();
  await expect(preview.getByText("ISS-1 → ISS-3")).toBeVisible();

  // Cancel leaves the workspace unchanged.
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(data.getByText("Import canceled.")).toBeVisible();
  await nav.getByRole("link", { name: "Issues" }).click();
  await expect(page.getByRole("link", { name: "Existing one" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Copied one" })).toHaveCount(0);

  await nav.getByRole("link", { name: "Settings" }).click();
  await file.setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(content),
  });
  await preview.getByRole("button", { name: "Import" }).click();
  await expect(
    data.getByText("Imported 0 projects and 2 issues from backup.json."),
  ).toBeVisible();
  await nav.getByRole("link", { name: "Issues" }).click();
  await expect(page.getByRole("link", { name: "Copied one" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Copied two" })).toBeVisible();
});

test("opens a document from a workspace content search", async ({ page }) => {
  await seedIssues(page, [{ title: "Exercise" }]);
  await page.addInitScript(() =>
    Reflect.set(window, "__seedDocuments", ["Field notes"]),
  );
  await page.goto("/issues");
  await expect(page.getByRole("link", { name: "Exercise" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+K");
  const dialog = page.getByRole("dialog", { name: "Search the workspace" });
  await dialog.getByRole("combobox").fill("body");
  const option = dialog
    .getByRole("group", { name: /Documents/ })
    .getByRole("option");
  await expect(option).toContainText("Field notes");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Document title")).toHaveValue("Field notes");
});

test("schedules, moves, and deletes work sessions apart from the deadline", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-16T10:00:00Z"));
  await page.goto("/issues");
  await createIssue(page, "Write report");
  await page.getByRole("link", { name: /Write report/ }).click();
  const due = page.locator('input[type="date"]').last();
  await due.fill("2026-11-25");

  const add = async (date: string, start: string, end: string) => {
    await page.getByRole("button", { name: "Schedule work session" }).click();
    const form = page.getByRole("form", { name: "New session" });
    await form.getByLabel("Date", { exact: true }).fill(date);
    await form.getByLabel("Start").fill(start);
    await form.getByLabel("End").fill(end);
    await form.getByRole("button", { name: "Add session" }).click();
  };
  await add("2026-11-18", "09:00", "11:00");
  // Overlapping sessions are allowed.
  await add("2026-11-18", "10:00", "12:00");
  const sessions = page.getByRole("region", { name: "Work sessions" });
  await expect(sessions.getByRole("listitem")).toHaveCount(2);

  // A failed move keeps the form open and the session as it was.
  await sessions.getByRole("button", { name: /^Edit/ }).first().click();
  const form = page.getByRole("form", { name: "Edit session" });
  await form.getByLabel("End").fill("08:00");
  await form.getByRole("button", { name: "Save session" }).click();
  await expect(page.getByRole("alert")).toContainText("end later");
  await expect(form).toBeVisible();
  await form.getByLabel("Date", { exact: true }).fill("2026-11-19");
  await form.getByLabel("End").fill("10:00");
  await form.getByRole("button", { name: "Save session" }).click();
  await expect(page.getByText("Session moved.")).toBeVisible();
  await expect(due).toHaveValue("2026-11-25");

  // Sessions render apart from the deadline in the calendar.
  await sessions.getByRole("link").first().click();
  await expect(page.getByText("Work block:").first()).toBeVisible();
  await expect(page.getByText("Deadline:")).toHaveCount(0);

  // Completing the issue keeps its sessions.
  await page.getByText("Work block:").first().click();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(sessions.getByRole("listitem")).toHaveCount(2);
  await sessions
    .getByRole("button", { name: /^Delete/ })
    .first()
    .click();
  await expect(sessions.getByRole("listitem")).toHaveCount(1);
});

test.describe("Today schedule", () => {
  test.use({ timezoneId: "UTC", locale: "en-US" });

  test("Today shows events, free time, and deadlines ahead above the tasks", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-11-16T10:00:00Z"));
    await page.addInitScript(() =>
      Object.assign(window, {
        __seedIssues: [
          { title: "Late report", dueDate: "2026-11-10" },
          { title: "Send invoice", dueDate: "2026-11-18" },
        ],
        __seedEvents: [
          {
            title: "Standup",
            startLocal: "2026-11-16T13:00",
            endLocal: "2026-11-16T14:00",
          },
          {
            title: "Offsite",
            allDay: true,
            startDate: "2026-11-16",
            endDate: "2026-11-17",
          },
        ],
      }),
    );
    await page.goto("/today");
    const schedule = page.getByRole("region", { name: "Schedule" });
    await expect(
      schedule.getByRole("button", { name: "Standup" }),
    ).toBeVisible();
    await expect(schedule.getByText("Offsite")).toBeVisible();
    await expect(schedule.getByText(/Free in working hours/)).toBeVisible();
    // The later deadline is under Coming up, and the overdue one in the tasks.
    await expect(
      schedule
        .getByRole("list", { name: "Upcoming deadlines" })
        .getByText("Send invoice"),
    ).toBeVisible();
    await expect(schedule.getByText("Late report")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Late report" })).toBeVisible();

    // Quick create opens the shared editor and the new event joins the day.
    await schedule.getByRole("button", { name: "New event" }).click();
    const editor = page.getByRole("dialog", { name: "New event" });
    await editor.getByLabel("Title").fill("Review");
    await editor.getByLabel("Title").press("Enter");
    await expect(
      schedule.getByRole("button", { name: "Review" }),
    ).toBeVisible();
  });
});
