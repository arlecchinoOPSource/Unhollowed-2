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
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke(
          command: string,
          {
            id,
            title,
            content,
          }: { id?: string; title?: string; content?: string } = {},
        ) {
          const document = documents.find((item) => item.id === id);
          switch (command) {
            case "list_documents":
              return structuredClone(documents);
            case "get_document":
              return structuredClone(document);
            case "get_document_usage":
              return { projects: [], issues: [] };
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
