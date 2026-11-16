import { expect, test, type Page } from "@playwright/test";
import type {
  Issue,
  IssueFields,
  IssueQuery,
  IssueStatus,
  RepeatRule,
} from "../../src/database/issues";
import type { ProjectGoals } from "../../src/database/goals";
import type { RelationKind } from "../../src/database/relationships";
import type { Label, LabelInput } from "../../src/database/labels";
import type { SavedView, ViewConfig } from "../../src/database/savedViews";
import type { Milestone, MilestoneInput } from "../../src/database/milestones";
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
      {
        id: "project-2",
        name: "Garden",
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
    const labels: Label[] = [];
    // Saved views, optionally seeded through window.__seedViews.
    const views: SavedView[] = [];
    const milestones: Milestone[] = [];
    const goals: ProjectGoals = { missions: [], objectives: [], links: [] };
    const relationships: { child: string; parent: string }[] = [];
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
        labelIds: [],
        milestoneId: null,
        recurrenceId: null,
        recurring: false,
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
    // One-shot failures and held commands, for testing overlapping writes.
    const failOnce = new Set<string>();
    window.addEventListener("fail-once", (event) => {
      failOnce.add((event as CustomEvent<string>).detail);
    });
    const held = new Map<string, Promise<void>>();
    window.addEventListener("hold-command", (event) => {
      const command = (event as CustomEvent<string>).detail;
      held.set(
        command,
        new Promise((resolve) =>
          window.addEventListener(`release-${command}`, () => resolve(), {
            once: true,
          }),
        ),
      );
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
    // Recurring series, following the backend rules: dates come from the
    // anchor, missed dates are skipped, and only one next occurrence exists.
    const series = new Map<
      string,
      {
        frequency: RepeatRule["frequency"];
        interval: number;
        anchor: string;
        stopped: boolean;
      }
    >();
    const occurrence = new Map<string, number>();
    const dayMs = 86_400_000;
    const occurrenceDate = (id: string, index: number) => {
      const rule = series.get(id)!;
      const [y, m, d] = rule.anchor.split("-").map(Number);
      let date: Date;
      if (rule.frequency === "monthly") {
        const months = m - 1 + index * rule.interval;
        const last = new Date(Date.UTC(y, months + 1, 0)).getUTCDate();
        date = new Date(Date.UTC(y, months, Math.min(d, last)));
      } else {
        const step = rule.frequency === "weekly" ? 7 : 1;
        date = new Date(
          Date.UTC(y, m - 1, d) + index * rule.interval * step * dayMs,
        );
      }
      return date.toISOString().slice(0, 10);
    };
    const advance = (issue: Issue, today?: string) => {
      const id = issue.recurrenceId;
      if (!id || series.get(id)?.stopped) return;
      const index = occurrence.get(issue.id) ?? 0;
      const later = issues.some(
        (other) =>
          other.recurrenceId === id && (occurrence.get(other.id) ?? 0) > index,
      );
      if (later) return;
      let next = index + 1;
      while (today && occurrenceDate(id, next) < today) next += 1;
      const time = now();
      const created: Issue = {
        ...structuredClone(issue),
        id: `issue-${issues.length + 1}`,
        number: issues.length + 1,
        status: "todo",
        closed: false,
        completedAt: null,
        dueDate: occurrenceDate(id, next),
        createdAt: time,
        updatedAt: time,
      };
      occurrence.set(created.id, next);
      issues.push(created);
    };
    const setStatus = (issue: Issue, status: IssueStatus, today?: string) => {
      if (issue.status === status) return issue;
      const wasClosed = issue.closed;
      issue.status = status;
      issue.closed = status === "done" || status === "canceled";
      issue.completedAt =
        status === "done" ? (issue.completedAt ?? now()) : null;
      issue.updatedAt = now();
      if (!wasClosed && issue.closed) advance(issue, today);
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
            labelIds?: string[];
            milestoneId?: string | null;
            otherId?: string;
            kind?: RelationKind;
            today?: string;
            rule?: RepeatRule | null;
          } = {},
        ) => {
          if (!seeded) {
            seeded = true;
            issues.push(...seed());
            views.push(
              ...((window as unknown as { __seedViews?: SavedView[] })
                .__seedViews ?? []),
            );
          }
          const hold = held.get(command);
          if (hold) {
            held.delete(command);
            await hold;
          }
          if (failing.has(command)) throw { code: "storage_failed" };
          if (failOnce.delete(command)) throw { code: "storage_failed" };
          switch (command) {
            case "list_projects":
              return projects;
            case "get_project": {
              const project = projects.find((item) => item.id === args.id);
              if (!project) throw { code: "not_found" };
              return project;
            }
            case "list_project_goals":
              return structuredClone({
                ...goals,
                objectives: goals.objectives.map((objective) => {
                  const linked = goals.links
                    .filter(([id]) => id === objective.id)
                    .map(([, id]) => find(id));
                  return {
                    ...objective,
                    total: linked.filter((issue) => issue.status !== "canceled")
                      .length,
                    completed: linked.filter((issue) => issue.status === "done")
                      .length,
                  };
                }),
              });
            case "save_project_mission": {
              const input = args.input as unknown as {
                title: string;
                description: string;
              };
              goals.missions.push({ id: "sample-mission", ...input });
              return;
            }
            case "save_project_objective": {
              const { issueIds, ...input } = args.input as unknown as {
                title: string;
                description: string;
                missionId: string | null;
                issueIds: string[];
              };
              goals.objectives.push({
                id: "sample-objective",
                ...input,
                completed: 0,
                total: 0,
              });
              goals.links.push(
                ...issueIds.map((id): [string, string] => [
                  "sample-objective",
                  id,
                ]),
              );
              return;
            }
            case "list_issues":
              return structuredClone(
                issues.filter(
                  (issue) =>
                    !args.projectId || issue.projectId === args.projectId,
                ),
              );
            case "list_issue_relationships":
              return relationships
                .filter(
                  (edge) => edge.child === args.id || edge.parent === args.id,
                )
                .map((edge) => {
                  const isChild = edge.child === args.id;
                  const { id, title, number, status } = find(
                    isChild ? edge.parent : edge.child,
                  );
                  return {
                    id,
                    title,
                    number,
                    status,
                    kind: isChild ? "parent" : "child",
                  };
                });
            case "add_issue_relationship":
              if (args.kind === "child" && args.id && args.otherId) {
                relationships.push({ parent: args.id, child: args.otherId });
                return;
              }
              throw { code: "cycle" };
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
                      : q.undated !== "exclude") &&
                  (!q.labelIds?.length ||
                    (q.labelMatch === "all"
                      ? q.labelIds.every((id) => issue.labelIds.includes(id))
                      : q.labelIds.some((id) =>
                          issue.labelIds.includes(id),
                        ))) &&
                  (!(q.milestoneIds?.length || q.noMilestone) ||
                    (issue.milestoneId
                      ? (q.milestoneIds ?? []).includes(issue.milestoneId)
                      : Boolean(q.noMilestone))),
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
            case "list_saved_views":
              return structuredClone(
                [...views].sort((a, b) => a.name.localeCompare(b.name)),
              );
            case "create_saved_view":
            case "update_saved_view": {
              const { name, config } = args as unknown as {
                name: string;
                config: ViewConfig;
              };
              const trimmed = name.trim();
              if (
                views.some(
                  (view) =>
                    view.id !== args.id &&
                    view.name.toLowerCase() === trimmed.toLowerCase(),
                )
              )
                throw { code: "duplicate_name" };
              const existing = views.find((view) => view.id === args.id);
              if (command === "update_saved_view" && !existing)
                throw { code: "not_found" };
              const view: SavedView = existing ?? {
                id: `view-${views.length + 1}`,
                name: trimmed,
                config,
                createdAt: now(),
                updatedAt: now(),
              };
              Object.assign(view, { name: trimmed, config, updatedAt: now() });
              if (!existing) views.push(view);
              return structuredClone(view);
            }
            case "delete_saved_view": {
              const index = views.findIndex((view) => view.id === args.id);
              if (index < 0) throw { code: "not_found" };
              views.splice(index, 1);
              return null;
            }
            case "list_labels":
              return structuredClone(
                labels
                  .map((label) => ({
                    ...label,
                    issueCount: issues.filter((issue) =>
                      issue.labelIds.includes(label.id),
                    ).length,
                  }))
                  .sort(
                    (a, b) =>
                      Number(a.archived) - Number(b.archived) ||
                      a.name.localeCompare(b.name),
                  ),
              );
            case "create_label":
            case "update_label": {
              const input = (args as unknown as { input: LabelInput }).input;
              const name = input.name.trim();
              if (
                labels.some(
                  (label) =>
                    label.id !== args.id &&
                    label.name.toLowerCase() === name.toLowerCase(),
                )
              )
                throw { code: "duplicate_name" };
              const existing = labels.find((label) => label.id === args.id);
              if (command === "update_label" && !existing)
                throw { code: "not_found" };
              const label: Label = existing ?? {
                id: `label-${labels.length + 1}`,
                archived: false,
                archivedAt: null,
                issueCount: 0,
                createdAt: now(),
                updatedAt: now(),
                name,
                description: null,
                color: input.color,
              };
              Object.assign(label, { ...input, name, updatedAt: now() });
              if (!existing) labels.push(label);
              return structuredClone(label);
            }
            case "archive_label":
            case "restore_label": {
              const label = labels.find((item) => item.id === args.id);
              if (!label) throw { code: "not_found" };
              label.archived = command === "archive_label";
              label.archivedAt = label.archived ? now() : null;
              return structuredClone(label);
            }
            case "set_issue_labels": {
              const issue = find(args.id);
              const wanted = [...new Set(args.labelIds ?? [])].sort();
              for (const id of wanted) {
                const label = labels.find((item) => item.id === id);
                if (!label) throw { code: "invalid_label" };
                if (label.archived && !issue.labelIds.includes(id))
                  throw { code: "label_archived" };
              }
              if (wanted.join() !== issue.labelIds.join()) {
                issue.labelIds = wanted;
                issue.updatedAt = now();
              }
              return structuredClone(issue);
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
                labelIds: [],
                milestoneId: null,
                recurrenceId: null,
                recurring: false,
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
              return structuredClone(
                setStatus(find(args.id), args.status!, args.today),
              );
            case "complete_issue":
              return structuredClone(
                setStatus(find(args.id), "done", args.today),
              );
            case "set_issue_recurrence": {
              const issue = find(args.id);
              const rule = args.rule ?? null;
              const current = issue.recurrenceId
                ? series.get(issue.recurrenceId)
                : undefined;
              if (rule === null) {
                if (current) current.stopped = true;
              } else if (
                !current ||
                current.stopped ||
                current.frequency !== rule.frequency ||
                current.interval !== rule.interval
              ) {
                if (!issue.dueDate) throw { code: "recurrence_needs_due_date" };
                if (current) current.stopped = true;
                const id = `series-${series.size + 1}`;
                series.set(id, {
                  ...rule,
                  anchor: issue.dueDate,
                  stopped: false,
                });
                issue.recurrenceId = id;
                occurrence.set(issue.id, 0);
              }
              for (const item of issues)
                item.recurring = Boolean(
                  item.recurrenceId && !series.get(item.recurrenceId)?.stopped,
                );
              return structuredClone(issue);
            }
            case "get_issue_recurrence": {
              const issue = find(args.id);
              const rule = issue.recurrenceId && series.get(issue.recurrenceId);
              if (!rule) return null;
              const latest = issues
                .filter((item) => item.recurrenceId === issue.recurrenceId)
                .sort(
                  (a, b) =>
                    (occurrence.get(b.id) ?? 0) - (occurrence.get(a.id) ?? 0),
                )[0];
              return {
                id: issue.recurrenceId,
                frequency: rule.frequency,
                interval: rule.interval,
                anchorDate: rule.anchor,
                stopped: rule.stopped,
                stoppedAt: null,
                latestIssueId: latest.id,
                latestNumber: latest.number,
                latestDueDate: latest.dueDate,
                latestClosed: latest.closed,
              };
            }
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
              const target = args.projectId ?? null;
              // A milestone for another project no longer applies.
              const milestone = milestones.find(
                (item) => item.id === issue.milestoneId,
              );
              if (milestone?.projectId && milestone.projectId !== target)
                issue.milestoneId = null;
              issue.projectId = target;
              issue.updatedAt = now();
              return structuredClone(issue);
            }
            case "list_milestones":
              return structuredClone(
                milestones.map((milestone) => {
                  const linked = issues.filter(
                    (issue) => issue.milestoneId === milestone.id,
                  );
                  return {
                    ...milestone,
                    openCount: linked.filter((issue) => !issue.closed).length,
                    completedCount: linked.filter(
                      (issue) => issue.status === "done",
                    ).length,
                    canceledCount: linked.filter(
                      (issue) => issue.status === "canceled",
                    ).length,
                  };
                }),
              );
            case "create_milestone":
            case "update_milestone": {
              const input = (args as unknown as { input: MilestoneInput })
                .input;
              const existing = milestones.find((item) => item.id === args.id);
              if (command === "update_milestone" && !existing)
                throw { code: "not_found" };
              const milestone: Milestone = existing ?? {
                id: `milestone-${milestones.length + 1}`,
                projectId: args.projectId ?? null,
                closed: false,
                closedAt: null,
                openCount: 0,
                completedCount: 0,
                canceledCount: 0,
                createdAt: now(),
                updatedAt: now(),
                title: "",
                description: null,
                dueDate: null,
              };
              Object.assign(milestone, input, { updatedAt: now() });
              if (!existing) milestones.push(milestone);
              return structuredClone(milestone);
            }
            case "close_milestone":
            case "reopen_milestone": {
              const milestone = milestones.find((item) => item.id === args.id);
              if (!milestone) throw { code: "not_found" };
              milestone.closed = command === "close_milestone";
              milestone.closedAt = milestone.closed ? now() : null;
              return structuredClone(milestone);
            }
            case "set_issue_due_date": {
              const issue = find(args.id);
              const due = (args as { dueDate?: string | null }).dueDate ?? null;
              if (due && issue.startDate && issue.startDate > due)
                throw { code: "invalid_date_range" };
              if (issue.dueDate !== due) {
                issue.dueDate = due;
                issue.updatedAt = now();
              }
              return structuredClone(issue);
            }
            case "set_issue_milestone": {
              const issue = find(args.id);
              const id = args.milestoneId ?? null;
              if (id) {
                const milestone = milestones.find((item) => item.id === id);
                if (
                  !milestone ||
                  (milestone.projectId &&
                    milestone.projectId !== issue.projectId)
                )
                  throw { code: "invalid_milestone" };
                if (milestone.closed && issue.milestoneId !== id)
                  throw { code: "milestone_closed" };
              }
              if (issue.milestoneId !== id) {
                issue.milestoneId = id;
                issue.updatedAt = now();
              }
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
  await expect(page.getByText("1 of 1 issues done")).toBeVisible();
  await page.getByRole("link", { name: /ISS-1 Publish brief/ }).click();
  await expect(page.getByLabel("Issue title")).toHaveValue("Publish brief");
  await page.getByRole("link", { name: "Missions & objectives" }).click();
  await expect(
    page.getByRole("heading", { name: "Publish the launch brief" }),
  ).toBeVisible();
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
    page.getByRole("heading", { name: "Welcome to Unhollowed." }),
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

function dispatch(page: Page, type: string, detail?: string) {
  return page.evaluate(
    ([name, value]) =>
      window.dispatchEvent(
        value === undefined
          ? new Event(name)
          : new CustomEvent(name, { detail: value }),
      ),
    [type, detail] as const,
  );
}

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
    await expect(
      page.getByRole("link", { name: "Renew passport" }),
    ).toHaveCount(0);
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
