import { expect, test } from "@playwright/test";
import type {
  Project,
  ProjectInput,
  ProjectStatus,
} from "../../src/database/projects";

test.beforeEach(async ({ page }) => {
  // This exercises the UI with an in-memory substitute for Tauri IPC.
  // Rust tests and desktop smoke testing cover SQLite and the real IPC.
  await page.addInitScript(() => {
    let project: Project | undefined;
    const deferred = new Map<string, Promise<void>>();
    window.addEventListener("defer-project-save", (event) => {
      const command = (event as CustomEvent<string>).detail;
      deferred.set(
        command,
        new Promise((resolve) => {
          window.addEventListener(`finish-${command}`, () => resolve(), {
            once: true,
          });
        }),
      );
    });
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (
          command: string,
          args: {
            id?: string;
            input?: ProjectInput;
            status?: ProjectStatus;
          } = {},
        ) => {
          const wait = deferred.get(command);
          deferred.delete(command);
          await wait;
          if (command === "list_projects") return project ? [project] : [];
          if (command === "create_project" && args.input) {
            project = {
              ...args.input,
              id: "sample-project",
              status: "planned",
              createdAt: "2026-11-14T00:00:00Z",
              updatedAt: "2026-11-14T00:00:00Z",
            };
            return project;
          }
          if (!project || args.id !== project.id) throw { code: "not_found" };
          if (command === "get_project") return project;
          if (command === "update_project" && args.input) {
            project = { ...project, ...args.input };
            return project;
          }
          if (
            command === "archive_project" ||
            (command === "change_project_status" && args.status)
          ) {
            project = {
              ...project,
              status: command === "archive_project" ? "archived" : args.status!,
            };
            return project;
          }
          throw new Error(`Unexpected command: ${command}`);
        },
      },
      isTauri: true,
    });
  });
});

test("creates, opens, edits, filters, and archives projects through the desktop interface", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await nav.getByRole("link", { name: "Projects" }).click();
  await expect(
    page.getByRole("heading", { name: "No projects yet" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create project" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("textbox", { name: "Project name" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Create project" }).click();
  await dialog.getByLabel("Project name").fill("Studio launch");
  await dialog.getByLabel("Description").fill("Prepare sample materials");
  await dialog.getByLabel("Start date").fill("2026-11-20");
  await dialog.getByLabel("Target date").fill("2026-11-19");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "The target date must be on or after the start date.",
  );
  await dialog.getByLabel("Target date").fill("2026-11-30");
  await dialog.getByRole("button", { name: "Create project" }).click();

  await expect(page).toHaveURL(/\/projects\/sample-project$/);
  await expect(
    page.getByRole("heading", { name: "Studio launch", level: 1 }),
  ).toBeVisible();
  await expect(nav.getByRole("link", { name: "Projects" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "Edit project" }).click();
  await dialog.getByLabel("Project name").fill("Studio opening");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", { name: "Studio opening", level: 1 }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("defer-project-save", {
        detail: "change_project_status",
      }),
    ),
  );
  const status = page.getByLabel("Project status");
  await status.focus();
  await status.selectOption("active");
  await expect(page.getByRole("status")).toHaveText("Saving status…");
  await expect(status).toBeFocused();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("finish-change_project_status")),
  );
  await expect(page.getByRole("status")).toHaveText(
    "Status updated to Active.",
  );
  await expect(status).toBeFocused();
  await expect(status).toHaveValue("active");
  await page.getByRole("link", { name: "All projects" }).click();
  await page.getByLabel("Search projects").fill("sample materials");
  await page.getByLabel("Filter by status").selectOption("planned");
  await expect(
    page.getByText("No projects match these filters."),
  ).toBeVisible();
  await page.getByLabel("Filter by status").selectOption("active");
  await page.getByRole("link", { name: /Studio opening/ }).click();
  await page.getByLabel("Project status").selectOption("archived");
  await expect(page.getByRole("status")).toHaveText(
    "Status updated to Archived.",
  );
  await page.getByRole("link", { name: "All projects" }).click();
  await page.getByLabel("Filter by status").selectOption("archived");
  await expect(
    page.getByRole("link", { name: /Studio opening/ }),
  ).toBeVisible();
});

test("saves a new project without redirecting after the user goes back", async ({
  page,
}) => {
  await page.goto("/");
  const projects = page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Projects" });
  await projects.click();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("defer-project-save", {
        detail: "create_project",
      }),
    ),
  );
  await page.getByRole("button", { name: "Create project" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project name").fill("Saved in the background");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeVisible();

  await page.goBack();
  const home = page.getByRole("heading", { name: "Welcome to Unhollowed." });
  await expect(home).toBeVisible();
  await page.evaluate(async () => {
    window.dispatchEvent(new Event("finish-create_project"));
    // Let the save continuation and any resulting navigation run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await expect(home).toBeVisible();
  await projects.click();
  await expect(
    page.getByRole("link", { name: /Saved in the background/ }),
  ).toBeVisible();
});
