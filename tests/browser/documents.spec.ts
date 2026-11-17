import { strFromU8, unzipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page, version?: number, graphSize = 0) {
  await page.addInitScript(
    ({ schemaVersion, graphSize }) => {
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
      const folders: { id: string; parentId: string | null; name: string }[] =
        [];
      let image = "";
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          invoke(
            command: string,
            args: {
              id?: string;
              title?: string;
              content?: string;
              data?: string;
              input?: { kind: string; folder?: string; value?: boolean };
              name?: string;
              parentId?: string | null;
              folder?: string | null;
              format?: string;
              images?: Record<string, string>;
              settings?: { paper: string; landscape: boolean; margin: number };
            } = {},
          ) {
            const { id, title, content, data, input, name, parentId, folder } =
              args;
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
                if (input?.kind === "archive")
                  document.archivedAt = "2026-11-17";
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
                if (args.images) {
                  Reflect.set(window, "importedImages", args.images);
                  image = Object.values(args.images)[0] ?? "";
                }
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
              case "print_document": {
                // `nativePrintMode` picks the backend's answer: unset is the
                // WebView fallback, "native" opens the native dialog, "slow"
                // does so after a delay, and "fail" or "invalid" reject.
                Reflect.set(window, "nativePrintSettings", args.settings);
                Reflect.set(
                  window,
                  "nativePrintCalls",
                  (Reflect.get(window, "nativePrintCalls") ?? 0) + 1,
                );
                const mode = Reflect.get(window, "nativePrintMode");
                if (mode === "fail") throw { code: "print_unavailable" };
                if (mode === "invalid")
                  throw { code: "invalid_print_settings" };
                if (mode === "slow")
                  return new Promise((resolve) =>
                    setTimeout(() => resolve(true), 300),
                  );
                return mode === "native";
              }
              case "get_document_graph":
                if (graphSize) {
                  const extra = Array.from(
                    { length: graphSize },
                    (_, index) => ({
                      id: `node-${index}`,
                      title: `Graph note ${index}`,
                      folderId: null,
                    }),
                  );
                  return {
                    documents: [...documents, ...extra],
                    links: extra.map((item, index) => ({
                      source: index ? extra[index - 1].id : "one",
                      target: item.id,
                    })),
                    memberships: [],
                  };
                }
                return { documents, links: [{ source: "one", target: "two" }] };
              case "list_document_references":
                return [];
              case "save_document_file":
                Reflect.set(window, "savedDocumentFile", args);
                return "test";
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
    },
    { schemaVersion: version, graphSize },
  );
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
  await page.getByText("Export document", { exact: true }).click();
  await page.getByLabel("File format").selectOption("html");
  await page.getByRole("button", { name: "Save document file" }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "savedDocumentFile")))
    .toMatchObject({
      format: "html",
      content: expect.stringContaining('<img src="data:image/png;base64,'),
    });
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
  await page.evaluate(() => {
    window.print = () => {
      Reflect.set(window, "printRequested", true);
    };
  });
  await page.getByRole("button", { name: "Print / Save as PDF" }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "printRequested")))
    .toBe(true);
  expect(
    await page.evaluate(() => Reflect.get(window, "nativePrintSettings")),
  ).toEqual({ paper: "letter", landscape: true, margin: 25.4 });
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

test("uses the native print dialog once and reports print failures", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("textbox", { name: "Document content" }).waitFor();
  await page.getByText("Page setup and print", { exact: true }).click();
  await page.evaluate(() => {
    window.print = () => {
      Reflect.set(
        window,
        "webviewPrints",
        (Reflect.get(window, "webviewPrints") ?? 0) + 1,
      );
    };
    Reflect.set(window, "nativePrintMode", "slow");
  });
  const button = page.getByRole("button", { name: "Print / Save as PDF" });
  const count = (name: string) =>
    page.evaluate((key) => Reflect.get(window, key) ?? 0, name);

  // A double click sends one request, and the native dialog replaces the
  // WebView's print.
  await button.dblclick();
  await expect.poll(() => count("nativePrintCalls")).toBe(1);
  await page.waitForTimeout(400);
  expect(await count("nativePrintCalls")).toBe(1);
  expect(await count("webviewPrints")).toBe(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Failures are reported, and the WebView print is not used instead.
  await page.evaluate(() => Reflect.set(window, "nativePrintMode", "fail"));
  await button.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Could not open the print dialog. Try again.",
  );
  await page.evaluate(() => Reflect.set(window, "nativePrintMode", "invalid"));
  await button.click();
  await expect(page.getByRole("alert")).toHaveText(
    "These page settings cannot be printed. Check the margins.",
  );
  expect(await count("webviewPrints")).toBe(0);

  // A later success clears the message.
  await page.evaluate(() => Reflect.set(window, "nativePrintMode", "native"));
  await button.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
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
  const option = page
    .getByRole("group", { name: "Insert document link" })
    .getByRole("button", { name: "Second draft" });
  await expect(option).toBeVisible();
  await editor.press("ArrowDown");
  await expect(option).toBeFocused();
  await page.keyboard.press("Enter");
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

test("imports Markdown as a separate document and exports Markdown, text, and HTML", async ({
  page,
}) => {
  await setup(page);
  const file = page.getByLabel("Import document");
  await file.setInputFiles({
    name: "Field notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Field notes\n\n**Observation** with [reference](https://example.com).\n\n![Remote illustration](https://example.com/image.png)",
    ),
  });
  const editor = page.getByRole("textbox", { name: "Document content" });
  await expect(
    editor.getByRole("heading", { name: "Field notes" }),
  ).toBeVisible();
  await expect(editor.locator("strong")).toHaveText("Observation");
  await expect(editor.locator("img")).toHaveCount(0);
  await expect(
    page.getByText(
      "Markdown image references were imported as alternative text.",
    ),
  ).toBeVisible();
  await page.getByText("Export document", { exact: true }).click();
  const chooseFormat = page.getByLabel("File format");
  const save = page.getByRole("button", { name: "Save document file" });
  const result = () =>
    page.evaluate(() => Reflect.get(window, "savedDocumentFile"));
  for (const [format, marker] of [
    ["md", "**Observation**"],
    ["txt", "Observation with reference"],
    ["html", "<strong>Observation</strong>"],
  ]) {
    await chooseFormat.selectOption(format);
    await save.click();
    await expect.poll(result).toMatchObject({
      title: "Field notes",
      format,
      content: expect.stringContaining(marker),
    });
  }
  expect((await result()).content).toContain('href="https://example.com/"');
  await file.setInputFiles({
    name: "Plain.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Line one\n\nLine three"),
  });
  await expect(editor.locator("p")).toHaveText(["Line one", "", "Line three"]);
});

test("writes a real Word file and imports its formatting, table, and image", async ({
  page,
}) => {
  await setup(page);
  const input = page.getByLabel("Import document");
  await input.setInputFiles({
    name: "Word sample.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Findings\n\nThis is **important** and has a [source](https://example.com).\n\n| Region | Result |\n|---|---|\n| North | Good |",
    ),
  });
  const editor = page.getByRole("textbox", { name: "Document content" });
  await expect(editor.getByRole("heading", { name: "Findings" })).toBeVisible();
  await page.getByText("Insert and tables", { exact: true }).click();
  await editor.press("ControlOrMeta+End");
  await page.getByLabel("Insert image").setInputFiles({
    name: "word-picture.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.getByRole("img", { name: "word-picture" })).toBeVisible();
  await page.getByText("Export document", { exact: true }).click();
  await page.getByLabel("File format").selectOption("docx");
  await page.getByRole("button", { name: "Save document file" }).click();
  const saved = () =>
    page.evaluate(() => Reflect.get(window, "savedDocumentFile"));
  await expect
    .poll(saved)
    .toMatchObject({ format: "docx", title: "Word sample" });
  const data = Buffer.from((await saved()).content, "base64");
  const entries = unzipSync(data);
  const xml = strFromU8(entries["word/document.xml"]);
  expect(xml).toContain('w:val="Heading1"');
  expect(xml).toContain("<w:tbl>");
  expect(xml).toContain("w:hyperlink");
  expect(xml).toContain("w:drawing");
  expect(
    Object.keys(entries).some(
      (name) => name.startsWith("word/media/") && name.endsWith(".png"),
    ),
  ).toBe(true);
  await input.setInputFiles({
    name: "Round trip.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: data,
  });
  await expect(page.getByLabel("Document title")).toHaveValue("Round trip");
  await expect(editor.getByRole("heading", { name: "Findings" })).toBeVisible();
  await expect(editor.locator("strong")).toHaveText("important");
  await expect(editor.getByRole("link", { name: "source" })).toHaveAttribute(
    "href",
    "https://example.com/",
  );
  await expect(editor.locator("td").filter({ hasText: "North" })).toHaveCount(
    1,
  );
  await expect(page.getByRole("img", { name: "word-picture" })).toBeVisible();
});

test("round-trips a native document with fonts and rejects unknown versions", async ({
  page,
}) => {
  await setup(page);
  const editor = page.getByRole("textbox", { name: "Document content" });
  await expect(editor).toHaveText("A saved document");
  await editor.press("ControlOrMeta+a");
  await page
    .getByRole("combobox", { name: "Font family" })
    .selectOption("georgia");
  await page.getByText("Export document", { exact: true }).click();
  await page.getByLabel("File format").selectOption("u2doc");
  await page.getByRole("button", { name: "Save document file" }).click();
  const result = () =>
    page.evaluate(() => Reflect.get(window, "savedDocumentFile"));
  await expect.poll(result).toMatchObject({ format: "u2doc" });
  const portable = JSON.parse((await result()).content);
  expect(portable.content.attrs.schemaVersion).toBe(1);
  const file = page.getByLabel("Import document");
  await file.setInputFiles({
    name: "Future.u2doc",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ ...portable, title: "Future", version: 2 }),
    ),
  });
  await expect(page.getByRole("alert")).toContainText("unsupported format");
  await expect(page.getByLabel("Document title")).toHaveValue("First draft");
  await file.setInputFiles({
    name: "Native.u2doc",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...portable, title: "Native copy" })),
  });
  await expect(page.getByLabel("Document title")).toHaveValue("Native copy");
  await expect(editor.locator(".u2-font-georgia")).toHaveText(
    "A saved document",
  );
});

test("finds text by keyboard in a long document while Focus Mode is on", async ({
  page,
}) => {
  await setup(page);
  const body = Array.from(
    { length: 250 },
    (_, i) =>
      `Sample notes ${i + 1}. The observation stays readable after editing and saving.`,
  ).join("\n");
  await page.getByLabel("Import document").setInputFiles({
    name: "Long draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(body),
  });
  const editor = page.getByRole("textbox", { name: "Document content" });
  await expect(editor.locator("p")).toHaveCount(250);
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await editor.press("ControlOrMeta+f");
  const find = page.getByRole("searchbox", { name: "Find", exact: true });
  await expect(find).toBeFocused();
  await find.fill("Sample notes 249.");
  await expect(page.getByRole("button", { name: "Next match" })).toBeEnabled();
  await find.press("Escape");
  await expect(find).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Exit focus mode" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Focus mode", exact: true }),
  ).toBeVisible();
});

test("renders a global graph with 500 connected notes and filters its navigation by title", async ({
  page,
}) => {
  await setup(page, undefined, 500);
  await page.getByRole("link", { name: "Graph", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Knowledge graph" }),
  ).toBeVisible();
  await expect(page.locator(".graph-canvas canvas").first()).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Find a document" })
    .fill("Graph note 499");
  await expect(
    page.getByRole("link", { name: "Graph note 499" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Graph note 498" })).toHaveCount(
    0,
  );
});
