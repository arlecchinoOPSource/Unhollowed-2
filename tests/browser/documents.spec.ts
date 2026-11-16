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
    const first = {
      id: "one",
      title: "First draft",
      content,
      updatedAt: "",
      createdAt: "",
    };
    const second = {
      id: "two",
      title: "Second draft",
      content,
      updatedAt: "",
      createdAt: "",
    };
    const documents = [first, second];
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
          }: {
            id?: string;
            title?: string;
            content?: string;
            data?: string;
          } = {},
        ) {
          const document = documents.find((item) => item.id === id);
          switch (command) {
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
