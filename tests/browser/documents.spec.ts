import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page, version?: number) {
  await page.addInitScript((schemaVersion) => {
    const content = JSON.stringify({
      type: "doc",
      ...(schemaVersion ? { attrs: { schemaVersion } } : {}),
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "A saved document" }],
        },
      ],
    });
    const meta = {
      folderId: null as string | null,
      favorite: false,
      archivedAt: null as string | null,
      openedAt: null as string | null,
    };
    const first = {
      ...meta,
      id: "one",
      title: "First draft",
      content,
      updatedAt: "",
      createdAt: "",
    };
    const second = {
      ...meta,
      id: "two",
      title: "Second draft",
      content,
      updatedAt: "",
      createdAt: "",
    };
    const documents = [first, second];
    const folders: { id: string; parentId: string | null; name: string }[] = [];
    let image = "";
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke(
          command: string,
          {
            id,
            title,
            content,
            data,
            input,
            name,
            parentId,
            folder,
          }: {
            id?: string;
            title?: string;
            content?: string;
            data?: string;
            input?: { kind: string; folder?: string; value?: boolean };
            name?: string;
            parentId?: string | null;
            folder?: string | null;
          } = {},
        ) {
          const document = documents.find((item) => item.id === id);
          switch (command) {
            case "list_document_library":
              return structuredClone({ documents, folders });
            case "change_document_library":
              if (!document) throw new Error("Missing document");
              if (input?.kind === "move")
                document.folderId = input.folder ?? null;
              if (input?.kind === "favorite")
                document.favorite = Boolean(input.value);
              if (input?.kind === "archive") document.archivedAt = "2026-11-17";
              if (input?.kind === "restore") document.archivedAt = null;
              return structuredClone(document);
            case "create_document_folder": {
              const item = {
                id: `folder-${folders.length + 1}`,
                parentId: parentId ?? null,
                name: name!,
              };
              folders.push(item);
              return structuredClone(item);
            }
            case "create_library_document": {
              const item = {
                ...first,
                ...meta,
                id: `doc-${documents.length + 1}`,
                title: title!,
                content: content!,
                folderId: folder ?? null,
              };
              documents.push(item);
              return structuredClone(item);
            }
            case "get_document_graph":
              return { documents, links: [{ source: "one", target: "two" }] };
            case "list_document_references":
              return [];
            case "list_documents":
              return structuredClone(documents);
            case "get_document":
              return structuredClone(document);
            case "get_document_usage":
              return { projects: [], issues: [] };
            case "store_document_image":
              image = data ?? "";
              return "image-1";
            case "get_document_image":
              return { mime: "image/png", data: image };
            case "update_document": {
              Object.assign(document!, { title, content });
              return structuredClone(document);
            }
            default:
              throw new Error(`Unexpected command: ${command}`);
          }
        },
      },
    });
  }, version);
  await page.goto("/documents?doc=one");
}

test("formats a legacy document and restores its new styles after switching documents", async ({
  page,
}) => {
  await setup(page);
  const editor = page.getByRole("textbox", { name: "Document content" });
  await expect(editor).toHaveText("A saved document");
  await editor.press("ControlOrMeta+a");
  await page
    .getByRole("combobox", { name: "Font family" })
    .selectOption("georgia");
  await page.getByRole("combobox", { name: "Font size" }).selectOption("24");
  await page.getByRole("button", { name: "Underline", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Style", exact: true })
    .selectOption("3");
  await page.getByText("Paragraph and lists", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Alignment" })
    .selectOption("center");
  await expect(editor.locator("h3")).toHaveCSS("text-align", "center");
  await expect(editor.locator(".u2-font-georgia")).toHaveCSS(
    "font-size",
    "32px",
  );
  await expect(page.getByText("All changes saved")).toBeVisible();

  await page.getByRole("button", { name: "Second draft" }).click();
  await expect(editor.locator("h3")).toHaveCount(0);
  await page.getByRole("button", { name: "First draft" }).click();
  await expect(editor.locator("h3 u")).toHaveText("A saved document");
  await expect(editor.locator("h3")).toHaveCSS("text-align", "center");
  await expect(editor.locator(".u2-font-georgia")).toHaveCSS(
    "font-size",
    "32px",
  );
});

test("preserves unsupported documents without opening an editable surface", async ({
  page,
}) => {
  await setup(page, 99);
  await expect(page.getByRole("alert")).toHaveText(/unsupported or damaged/);
  await expect(
    page.getByRole("textbox", { name: "Document content" }),
  ).toHaveCount(0);
});

test("replaces literal text, undoes it, and exits focus mode with Escape", async ({
  page,
}) => {
  await setup(page);
  const editor = page.getByRole("textbox", { name: "Document content" });
  await page.getByRole("button", { name: "Find & replace" }).click();
  await page.getByRole("searchbox", { name: "Find" }).fill("saved document");
  await page
    .getByRole("textbox", { name: "Replace with" })
    .fill("revised note");
  await page.getByRole("button", { name: "Replace all" }).click();
  await expect(editor).toHaveText("A revised note");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor).toHaveText("A saved document");
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace" }),
  ).toBeHidden();
  await editor.press("Escape");
  await expect(
    page.getByRole("navigation", { name: "Workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Focus mode", exact: true }),
  ).toBeFocused();
});

test("recovers a draft after reloading before the debounce expires", async ({
  page,
}) => {
  await page.clock.install();
  await setup(page);
  const editor = page.getByRole("textbox", { name: "Document content" });
  await editor.fill("Recover these edits");
  await page.reload();
  await expect(
    page.getByText("Unsaved edit recovery available."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resume unsaved edits" }).click();
  await expect(editor).toHaveText("Recover these edits");
  await page.clock.fastForward(800);
  await expect(page.getByText("All changes saved")).toBeVisible();
});

test("persists a table and local image reference across document switches", async ({
  page,
}) => {
  await setup(page);
  const editor = page.getByRole("textbox", { name: "Document content" });
  await page.getByText("Insert and tables", { exact: true }).click();
  await page.getByRole("button", { name: "Insert table", exact: true }).click();
  await expect(editor.locator("tr")).toHaveCount(3);
  await page.getByRole("button", { name: "Add row", exact: true }).click();
  await expect(editor.locator("tr")).toHaveCount(4);
  await editor.press("ControlOrMeta+End");
  await page.getByLabel("Insert image").setInputFiles({
    name: "sample.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const image = page.getByRole("img", { name: "sample" });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    )
    .toBe(1);
  await expect(page.getByText("All changes saved")).toBeVisible();
  await page.getByRole("button", { name: "Second draft" }).click();
  await expect(image).toHaveCount(0);
  await page.getByRole("button", { name: "First draft" }).click();
  await expect(editor.locator("tr")).toHaveCount(4);
  await expect(image).toBeVisible();
});

test("prints the selected paper geometry and an explicit page break", async ({
  page,
}) => {
  await setup(page);
  const editor = page.getByRole("textbox", { name: "Document content" });
  await page.getByText("Page setup and print", { exact: true }).click();
  await page.getByRole("combobox", { name: "Paper" }).selectOption("letter");
  await page
    .getByRole("combobox", { name: "Orientation" })
    .selectOption("landscape");
  await page.getByLabel("Page header", { exact: true }).fill("Research brief");
  await page.getByLabel("Page numbers").check();
  await editor.press("End");
  await page.getByRole("button", { name: "Insert page break" }).click();
  await editor.press("ControlOrMeta+End");
  await page.keyboard.type("On the following page.");
  const pdf = await page.pdf({ preferCSSPageSize: true });
  const structure = pdf.toString("latin1");
  expect(structure).toMatch(/\/MediaBox\s*\[0 0 792 612\]/);
  expect(structure).toMatch(/\/Count 2\b/);
  await expect(page.getByText("All changes saved")).toBeVisible();
  await page.getByRole("button", { name: "Second draft" }).click();
  await page.getByRole("button", { name: "First draft" }).click();
  await page.getByText("Page setup and print", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Orientation" })).toHaveValue(
    "landscape",
  );
  await expect(page.getByLabel("Page header", { exact: true })).toHaveValue(
    "Research brief",
  );
});

test("organizes documents in nested folders, filters favorites, and creates a template", async ({
  page,
}) => {
  await setup(page);
  await page.getByText("Organize documents", { exact: true }).click();
  const name = page.getByLabel("New folder name");
  await name.fill("Research");
  await page
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Parent folder", exact: true })
    .selectOption({ label: "Research" });
  await name.fill("Notes");
  await page
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Move document", exact: true })
    .selectOption({ label: "Research / Notes" });
  await page.getByRole("button", { name: "Add favorite", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Show documents", exact: true })
    .selectOption("favorites");
  await expect(
    page.getByRole("button", { name: "First draft", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Second draft", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Archive document", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "First draft", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Show documents", exact: true })
    .selectOption("archived");
  await expect(
    page.getByRole("button", { name: "First draft", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Restore document", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Template", exact: true })
    .selectOption("Meeting notes");
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Agenda", exact: true }),
  ).toBeVisible();
});

test("inserts a document reference and follows it in the editor", async ({
  page,
}) => {
  await setup(page);
  const editor = page.getByRole("textbox", { name: "Document content" });
  await editor.press("End");
  await editor.press("Enter");
  await page.keyboard.insertText("[[Second");
  await page
    .getByRole("group", { name: "Insert document link" })
    .getByRole("button", { name: "Second draft" })
    .click();
  const link = editor.getByRole("link", { name: "Second draft" });
  await expect(link).toHaveAttribute("href", "/documents?doc=two");
  await link.click();
  await expect(page).toHaveURL(/doc=two$/);
});

test("opens a local graph and finds a neighboring document", async ({
  page,
}) => {
  await setup(page);
  await page.getByText("Document links", { exact: true }).click();
  await page.getByRole("link", { name: "Open local graph" }).click();
  await expect(
    page.getByRole("heading", { name: "Graph · First draft" }),
  ).toBeVisible();
  await expect(page.locator(".graph-canvas canvas").first()).toBeVisible();
  await page.getByRole("searchbox", { name: "Find a document" }).fill("second");
  await page.getByRole("link", { name: "Second draft" }).click();
  await expect(page).toHaveURL(/doc=two$/);
});
