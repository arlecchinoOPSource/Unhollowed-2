import { Extension, Node } from "@tiptap/react";

export const paperSizes = {
  a4: { label: "A4", dimensions: [210, 297] },
  letter: { label: "US Letter", dimensions: [215.9, 279.4] },
  legal: { label: "Legal", dimensions: [215.9, 355.6] },
} as const;

export interface Layout {
  paper: keyof typeof paperSizes;
  landscape: boolean;
  margin: number;
  header: string;
  footer: string;
  numbers: boolean;
}

export function readLayout(value: unknown): Layout {
  const input =
    value && typeof value === "object" ? (value as Partial<Layout>) : {};
  return {
    paper:
      input.paper && Object.hasOwn(paperSizes, input.paper)
        ? input.paper
        : "a4",
    landscape: input.landscape === true,
    margin:
      typeof input.margin === "number" &&
      input.margin >= 10 &&
      input.margin <= 50
        ? input.margin
        : 25.4,
    header: typeof input.header === "string" ? input.header.slice(0, 120) : "",
    footer: typeof input.footer === "string" ? input.footer.slice(0, 120) : "",
    numbers: input.numbers === true,
  };
}

function cssString(value: string): string {
  // Escape by code point. Text must never escape the CSS content string.
  return (
    '"' +
    Array.from(value)
      .map((char) => `\\${char.codePointAt(0)!.toString(16)} `)
      .join("") +
    '"'
  );
}

export function pageCss(layout: Layout) {
  const [width, height] = dimensions(layout);
  const margin = layout.margin;
  const header =
    layout.header &&
    `@top-center { content: ${cssString(layout.header)}; font-size: 9pt; }`;
  const footer =
    layout.footer &&
    `@bottom-center { content: ${cssString(layout.footer)}; font-size: 9pt; }`;
  const numbers =
    layout.numbers &&
    "@bottom-right { content: counter(page); font-size: 9pt; }";
  return `@page { size: ${width}mm ${height}mm; margin: ${margin}mm; ${header} ${footer} ${numbers} }`;
}

export function dimensions(layout: Layout) {
  const [width, height] = paperSizes[layout.paper].dimensions;
  return layout.landscape ? [height, width] : [width, height];
}

export const DocumentPageLayout = Extension.create({
  name: "documentPageLayout",
  addGlobalAttributes: () => [
    {
      types: ["doc"],
      attributes: { pageLayout: { default: null, rendered: false } },
    },
  ],
});

export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  parseHTML: () => [{ tag: "div[data-document-break]" }],
  renderHTML: () => [
    "div",
    { "data-document-break": "", contenteditable: "false" },
    "Page break",
  ],
});
