import { expect, test, type Page } from "@playwright/test";

// A fixture matrix for ordinary school and office documents (U2-P6-10). The
// real export and import modules run in Chromium through the dev server.

const structure = `
<h1>Title</h1><h2>Section</h2><h3>Detail</h3>
<p>Plain <strong>bold</strong> <em>italic</em> <u>under</u> <s>strike</s> <a href="https://example.com/x">link</a></p>
<ul><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li></ul>
<ol><li><p>first</p></li><li><p>second</p></li></ol>
<table><tbody><tr><th><p>H1</p></th><th><p>H2</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>
<blockquote><p>quoted</p></blockquote>`;

const formatted = {
  type: "doc",
  attrs: {
    schemaVersion: 1,
    pageLayout: { paper: "letter", landscape: true, margin: 20 },
  },
  content: [
    {
      type: "paragraph",
      attrs: {
        align: "center",
        leading: "double",
        before: "large",
        after: "small",
      },
      content: [
        {
          type: "text",
          text: "Centered Georgia",
          marks: [
            {
              type: "documentInlineStyle",
              attrs: { font: "georgia", size: 18 },
            },
          ],
        },
      ],
    },
    {
      type: "paragraph",
      attrs: { align: "justify" },
      content: [{ type: "text", text: "Justified body text." }],
    },
    { type: "pageBreak" },
    { type: "paragraph", content: [{ type: "text", text: "After the break" }] },
  ],
};

async function roundTrip(page: Page, content: unknown) {
  await page.goto("/");
  return page.evaluate(async (content) => {
    const load = (p: string) => import(/* @vite-ignore */ p);
    const { exportWordFile } = await load(
      "/src/features/documents/editor/exportWord.ts",
    );
    const { importWordFile } = await load(
      "/src/features/documents/editor/importWord.ts",
    );
    const base64 = await exportWordFile(content as never, "doc", "Fixture");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const imported = await importWordFile(new File([bytes], "Fixture.docx"));
    return imported.content;
  }, content);
}

type Node = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Node[];
};
const walk = (node: Node, visit: (node: Node) => void) => {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
};
const counts = (root: Node) => {
  const nodes: Record<string, number> = {};
  const marks: Record<string, number> = {};
  let text = "";
  walk(root, (node) => {
    nodes[node.type] = (nodes[node.type] ?? 0) + 1;
    for (const mark of node.marks ?? [])
      marks[mark.type] = (marks[mark.type] ?? 0) + 1;
    if (node.text) text += node.text;
  });
  return { nodes, marks, text };
};

test("Word keeps headings, inline marks, lists, nested lists, tables, links, and text", async ({
  page,
}) => {
  const content = (await page.goto("/").then(() =>
    page.evaluate(async (html) => {
      const load = (p: string) => import(/* @vite-ignore */ p);
      const schema = await load("/src/features/documents/editor/schema.ts");
      const react = await load("/node_modules/.vite/deps/@tiptap_react.js");
      return react.generateJSON(html, schema.documentExtensions);
    }, structure),
  )) as Node;
  const before = counts(content);
  const after = counts((await roundTrip(page, content)) as Node);
  for (const kept of [
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "table",
    "tableHeader",
    "tableCell",
  ])
    expect(after.nodes[kept], kept).toBe(before.nodes[kept]);
  for (const kept of ["bold", "italic", "strike", "link"])
    expect(after.marks[kept], kept).toBe(before.marks[kept]);
  expect(after.text.replace(/\s+/g, "")).toBe(before.text.replace(/\s+/g, ""));
  // Known, accepted differences: Word styles hyperlinks as underlined, and a
  // block quote comes back as an ordinary paragraph (its text is kept).
  expect(after.marks.underline).toBe(
    before.marks.underline + before.marks.link,
  );
  expect(after.nodes.blockquote ?? 0).toBe(0);
});

test("Word export writes alignment, font, size, page layout, and breaks; import keeps only the page layout", async ({
  page,
}) => {
  await page.goto("/");
  const { xml, imported } = await page.evaluate(async (content) => {
    const load = (p: string) => import(/* @vite-ignore */ p);
    const { exportWordFile } = await load(
      "/src/features/documents/editor/exportWord.ts",
    );
    const { importWordFile } = await load(
      "/src/features/documents/editor/importWord.ts",
    );
    const { unzipSync, strFromU8 } = await load(
      "/node_modules/.vite/deps/fflate.js",
    );
    const base64 = await exportWordFile(content as never, "doc", "Fixture");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return {
      xml: strFromU8(unzipSync(bytes)["word/document.xml"]),
      imported: (await importWordFile(new File([bytes], "Fixture.docx")))
        .content,
    };
  }, formatted);
  // What Word receives.
  expect(xml).toContain('<w:jc w:val="center"/>');
  expect(xml).toContain('<w:jc w:val="both"/>');
  expect(xml).toContain('w:ascii="Georgia"');
  expect(xml).toContain('<w:sz w:val="36"/>');
  expect(xml).toMatch(/<w:spacing [^>]*w:line="480"/);
  expect(xml).toContain('<w:br w:type="page"/>');
  expect(xml).toContain(
    '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>',
  );
  // What comes back. Known limit (see docs/DOCUMENT_EDITOR.md): the Word
  // reader keeps text and page layout but not alignment, spacing, font, size,
  // or the page break. If this starts to pass, update the document.
  const root = imported as Node;
  expect(counts(root).text).toContain("Centered Georgia");
  expect(counts(root).text).toContain("After the break");
  const aligns: unknown[] = [];
  walk(root, (node) => {
    if (node.type === "paragraph") aligns.push(node.attrs?.align);
  });
  expect(aligns.every((align) => align === null)).toBe(true);
  expect(root.attrs?.pageLayout).toMatchObject({
    paper: "letter",
    landscape: true,
    margin: 20,
  });
});
