import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { dispatch, installIpcMock } from "./ipcMock";

test.use({ timezoneId: "Europe/Paris", locale: "en-US" });

async function open(page: Page, seed: object = {}) {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.addInitScript((data) => Object.assign(window, data), seed);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /^Good (morning|afternoon|evening)\.$/ }),
  ).toBeVisible();
}

const section = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("Home shows today's work, each item linked to its source", async ({
  page,
}) => {
  await open(page, {
    __seedIssues: [
      { title: "Renew passport", dueDate: "2026-11-12" },
      { title: "Send invoice", dueDate: "2026-11-17", priority: "high" },
      { title: "Plan trip", dueDate: "2026-11-30" },
    ],
    __seedHabits: {
      today: "2026-11-17",
      habits: [
        { name: "Walk", startDate: "2026-11-01" },
        { name: "Read", startDate: "2026-11-01" },
      ],
    },
  });
  const overdue = section(page, "Overdue");
  await expect(overdue).toContainText("Renew passport");
  await expect(overdue).not.toContainText("Send invoice");
  await expect(
    overdue.getByRole("link", { name: "Open overdue issues" }),
  ).toHaveAttribute("href", "/issues?due=overdue");

  const today = section(page, "Due today");
  await expect(today).toContainText("Send invoice");
  await expect(today).not.toContainText("Plan trip");
  await expect(
    today.getByRole("link", { name: /Send invoice/ }),
  ).toHaveAttribute("href", /\/issues\/.+/);

  const habits = section(page, "Habits today");
  await expect(habits.getByRole("link", { name: "Walk" })).toHaveAttribute(
    "href",
    /\/habits\?habit=.+&date=2026-11-17/,
  );
  await expect(habits).toContainText("0 of 2 done today.");

  await expect(section(page, "Active projects")).toContainText("Studio launch");
});

test("every section explains an empty workspace", async ({ page }) => {
  await open(page);
  await expect(section(page, "Overdue")).toContainText("Nothing is overdue.");
  await expect(section(page, "Due today")).toContainText(
    "Nothing is due today.",
  );
  await expect(section(page, "Habits today")).toContainText(
    "No habits to do today.",
  );
  await expect(section(page, "Upcoming milestones")).toContainText(
    "Nothing due in the next two weeks.",
  );
  await expect(section(page, "Recent documents")).toContainText(
    "No documents yet.",
  );
});

test("a failing source takes down only its own section, which can be retried", async ({
  page,
}) => {
  await installIpcMock(page);
  await page.clock.setFixedTime(new Date("2026-11-17T10:00:00+01:00"));
  await page.goto("/issues");
  await dispatch(page, "fail-command", "list_projects");
  // Navigate inside the app so the failing mock stays installed.
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  const projects = section(page, "Active projects");
  await expect(projects.getByRole("alert")).toBeVisible();
  await expect(projects.getByRole("button", { name: "Retry" })).toBeVisible();
  // Others are fine.
  await expect(section(page, "Overdue")).toContainText("Nothing is overdue.");
  await expect(section(page, "Recent documents")).toBeVisible();
});

test("each list is bounded and points to the full list", async ({ page }) => {
  await open(page, {
    __seedIssues: Array.from({ length: 8 }, (_, i) => ({
      title: `Late ${i + 1}`,
      dueDate: "2026-11-10",
    })),
  });
  const overdue = section(page, "Overdue");
  await expect(overdue.getByRole("listitem")).toHaveCount(5);
  await expect(overdue.getByRole("link", { name: "3 more" })).toHaveAttribute(
    "href",
    "/issues?due=overdue",
  );
});

test("the summary follows the local date when the day changes", async ({
  page,
}) => {
  await installIpcMock(page);
  await page.clock.install({ time: new Date("2026-11-17T23:59:30+01:00") });
  await page.addInitScript(() =>
    Object.assign(window, {
      __seedIssues: [{ title: "Due the 18th", dueDate: "2026-11-18" }],
    }),
  );
  await page.goto("/");
  await expect(section(page, "Due today")).toContainText(
    "Nothing is due today.",
  );
  await page.clock.fastForward(60_000);
  await expect(section(page, "Due today")).toContainText("Due the 18th");
});

test("Home passes automated accessibility checks and keeps the area directory", async ({
  page,
}) => {
  await open(page);
  await page.getByText("All areas").click();
  await expect(
    page.getByRole("link", { name: /Calendar/ }).first(),
  ).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

const actions = (page: Page) =>
  page.getByRole("region", { name: "Quick actions", exact: true });

test("a new issue is created once through the existing command, and focus returns", async ({
  page,
}) => {
  await open(page);
  const button = actions(page).getByRole("button", { name: "New issue" });
  await button.click();
  const title = actions(page).getByLabel("Issue title");
  await expect(title).toBeFocused();
  await title.fill("Call the venue");
  await actions(page).getByRole("button", { name: "Create issue" }).click();
  await expect(actions(page).getByRole("status")).toContainText(
    "Created ISS-1 Call the venue.",
  );
  await expect(button).toBeFocused();
  // In-app navigation keeps the in-memory backend.
  await page.getByRole("link", { name: "Issues", exact: true }).first().click();
  await expect(page.getByText("Call the venue")).toHaveCount(1);
});

test("a failed or cancelled issue keeps what was typed and leaves focus usable", async ({
  page,
}) => {
  await open(page);
  await actions(page).getByRole("button", { name: "New issue" }).click();
  await actions(page).getByLabel("Issue title").fill("Draft title");
  await dispatch(page, "fail-command", "create_issue");
  await actions(page).getByRole("button", { name: "Create issue" }).click();
  await expect(actions(page).getByRole("alert")).toBeVisible();
  await expect(actions(page).getByLabel("Issue title")).toHaveValue(
    "Draft title",
  );
  await actions(page).getByRole("button", { name: "Cancel" }).click();
  await expect(
    actions(page).getByRole("button", { name: "New issue" }),
  ).toBeFocused();
});

test("add event uses the event editor and says what it saved", async ({
  page,
}) => {
  await open(page);
  await actions(page).getByRole("button", { name: "New event" }).click();
  const editor = page.getByRole("dialog", { name: "New event" });
  await editor.getByLabel("Title").fill("Standup");
  await editor.getByRole("button", { name: "Save event" }).click();
  await expect(actions(page).getByRole("status")).toContainText(
    "Created event Standup.",
  );
});

test("document, check-in, project, and issue-work actions open the screens that own them", async ({
  page,
}) => {
  await open(page, { __seedIssues: [{ title: "Plan the offsite" }] });
  await expect(
    actions(page).getByRole("link", { name: "Check in" }),
  ).toHaveAttribute("href", "/mood");
  await expect(
    actions(page).getByRole("link", { name: /^Open / }),
  ).toHaveAttribute("href", /\/projects\/.+/);

  await actions(page).getByRole("button", { name: "Plan work" }).click();
  const dialog = page.getByRole("dialog", { name: "Plan work" });
  await dialog
    .getByLabel("Issue")
    .selectOption({ label: "ISS-1 Plan the offsite" });
  await dialog.getByRole("button", { name: "Open issue" }).click();
  await expect(page).toHaveURL(/\/issues\/.+/);
  await expect(
    page.getByRole("heading", { name: "Work sessions" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await actions(page).getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/documents\?doc=/);
});

test("checking a habit on Home updates its summary", async ({ page }) => {
  await open(page, {
    __seedHabits: {
      today: "2026-11-17",
      habits: [
        { name: "Walk", startDate: "2026-11-01" },
        { name: "Read", startDate: "2026-11-01" },
      ],
    },
  });
  const habits = section(page, "Habits today");
  await expect(habits).toContainText("0 of 2 done today.");
  await habits
    .getByRole("button", { name: /^(Mark done|Undo): Walk$/ })
    .click();
  await expect(habits).toContainText("1 of 2 done today.");
  await expect(
    habits.getByRole("button", { name: /^(Mark done|Undo): Walk$/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await habits
    .getByRole("button", { name: /^(Mark done|Undo): Walk$/ })
    .click();
  await expect(habits).toContainText("0 of 2 done today.");
});

test("resume: in-progress issues by last change, and documents and projects with their dates and work links", async ({
  page,
}) => {
  await open(page, {
    __seedIssues: [
      { title: "Draft the brief", status: "in_progress" },
      { title: "Not started", status: "todo" },
      { title: "Finished", status: "done" },
    ],
    __seedDocuments: ["Venue notes"],
  });
  const progress = section(page, "In progress");
  await expect(progress).toContainText("Draft the brief");
  await expect(progress).not.toContainText("Not started");
  await expect(progress).not.toContainText("Finished");
  await expect(progress).toContainText("updated");

  const docs = section(page, "Recent documents");
  await expect(docs.getByRole("link", { name: "Venue notes" })).toHaveAttribute(
    "href",
    /\/documents\?doc=.+/,
  );
  await expect(docs).toContainText("changed");

  const projects = section(page, "Active projects");
  await expect(
    projects.getByRole("link", { name: "Issues" }).first(),
  ).toHaveAttribute("href", /\/projects\/.+\/issues/);
});

test("the planning-to-completion journey keeps one issue, one document, and the way back", async ({
  page,
}) => {
  await open(page, {
    __seedIssues: [
      { title: "Book venue", dueDate: "2026-11-17", priority: "high" },
    ],
    __seedDocuments: ["Venue notes"],
  });

  // Home deadline to the issue, with Home as the way back.
  const due = section(page, "Due today");
  await due.getByRole("link", { name: /Book venue/ }).click();
  await expect(page).toHaveURL(/\/issues\/seed-1$/);
  await expect(
    page.getByRole("link", { name: "Home", exact: true }).last(),
  ).toBeVisible();
  const issueUrl = page.url();

  // Schedule work on this issue.
  await page.getByRole("button", { name: "Schedule work session" }).click();
  const form = page.getByRole("form", { name: "New session" });
  await form.getByLabel("Date", { exact: true }).fill("2026-11-17");
  await form.getByLabel("Start").fill("14:00");
  await form.getByLabel("End").fill("15:00");
  await form.getByRole("button", { name: "Add session" }).click();
  await expect(page.getByText("Session added.")).toBeVisible();

  // Link the document, open it, and return to the same issue.
  const linked = page.getByRole("region", { name: "Linked documents" });
  await linked
    .getByLabel("Link a document")
    .selectOption({ label: "Venue notes" });
  await linked.getByRole("button", { name: "Link", exact: true }).click();
  await linked.getByRole("link", { name: "Venue notes" }).click();
  await expect(page).toHaveURL(/\/documents\?doc=/);
  await page.getByLabel("Document title").fill("Venue notes v2");
  await page
    .getByRole("link", { name: /Back to/ })
    .first()
    .click();
  await expect(page).toHaveURL(issueUrl);
  await expect(linked.getByRole("link", { name: /Venue notes/ })).toBeVisible();
  // The session is still the one planned.
  await expect(
    page.getByRole("region", { name: "Work sessions" }).getByRole("listitem"),
  ).toHaveCount(1);

  // Complete it; Home no longer lists it as due.
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(page.getByText(/Completed/).first()).toBeVisible();
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect(section(page, "Due today")).toContainText(
    "Nothing is due today.",
  );
});

test("a link to a removed document or issue explains itself and offers a way out", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("link", { name: "Issues", exact: true }).first().click();
  await page.goto("/issues/issue-404");
  await expect(
    page.getByRole("heading", { name: "Issue unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "All issues" })).toBeVisible();
  await page.goto("/documents?doc=gone");
  await expect(page.getByRole("alert").first()).toBeVisible();
});
