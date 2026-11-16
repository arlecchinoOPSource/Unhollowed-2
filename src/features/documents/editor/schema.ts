import { DocumentReference } from "./DocumentReferences";
import { DocumentPageLayout, PageBreak } from "./pageLayout";
import { TableKit } from "@tiptap/extension-table";
import { DocumentImage } from "./DocumentImage";
import { Extension, Mark, getSchema, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

export const fonts = {
  sans: "Sans serif",
  serif: "Serif",
  mono: "Monospace",
  arial: "Arial",
  georgia: "Georgia",
  times: "Times New Roman",
  courier: "Courier New",
};
export const sizes = [9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
export const inks = {
  red: "Red",
  blue: "Blue",
  green: "Green",
  purple: "Purple",
};
export const highlights = { yellow: "Yellow", mint: "Mint", pink: "Pink" };
export const paragraphs = {
  align: {
    label: "Alignment",
    options: {
      left: "Left",
      center: "Center",
      right: "Right",
      justify: "Justified",
    },
  },
  leading: {
    label: "Line spacing",
    options: { single: "Single", relaxed: "1.5 lines", double: "Double" },
  },
  before: { label: "Space before", options: { small: "6 pt", large: "12 pt" } },
  after: {
    label: "Space after",
    options: { none: "0 pt", small: "6 pt", large: "12 pt" },
  },
  left: {
    label: "Left indent",
    options: { small: "0.25 in", large: "0.5 in" },
  },
  right: {
    label: "Right indent",
    options: { small: "0.25 in", large: "0.5 in" },
  },
  first: {
    label: "First line",
    options: { indent: "First-line indent", hanging: "Hanging indent" },
  },
};

function stylingAttribute(
  name: string,
  values: string[],
  pasted?: (element: HTMLElement) => string,
) {
  const prefix = `u2-${name}-`;
  return {
    default: null,
    parseHTML: (element: HTMLElement) =>
      values.find((value) => element.classList.contains(prefix + value)) ??
      values.find((value) => value === pasted?.(element)) ??
      null,
    renderHTML: (attributes: Record<string, unknown>) =>
      typeof attributes[name] === "string" && values.includes(attributes[name])
        ? { class: prefix + attributes[name] }
        : {},
  };
}

const BlockStyle = Extension.create({
  name: "documentBlockStyle",
  addGlobalAttributes() {
    return [
      {
        types: ["doc"],
        attributes: { schemaVersion: { default: 1, rendered: false } },
      },
      {
        types: ["paragraph", "heading"],
        attributes: Object.fromEntries(
          Object.entries(paragraphs).map(([name, { options }]) => [
            name,
            stylingAttribute(
              name,
              Object.keys(options),
              name === "align"
                ? (element) => element.style.textAlign
                : undefined,
            ),
          ]),
        ),
      },
    ];
  },
});

const CellStyles = Extension.create({
  name: "documentCellStyles",
  addGlobalAttributes() {
    return [
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          shade: stylingAttribute("shade", ["neutral", "accent"]),
          alignment: stylingAttribute("alignment", ["left", "center", "right"]),
          border: stylingAttribute("border", ["heavy"]),
        },
      },
    ];
  },
});

const InlineStyle = Mark.create({
  name: "documentInlineStyle",
  addAttributes() {
    return {
      font: stylingAttribute("font", Object.keys(fonts), (element) => {
        const family = element.style.fontFamily
          .split(",")[0]
          .trim()
          .replace(/['"]/g, "")
          .toLowerCase();
        return (
          Object.entries(fonts).find(
            ([, label]) => label.toLowerCase() === family,
          )?.[0] ?? ""
        );
      }),
      size: stylingAttribute("size", sizes.map(String), (element) => {
        const source = element.style.fontSize;
        return source.endsWith("pt") ? source.slice(0, -2) : "";
      }),
      ink: stylingAttribute("ink", Object.keys(inks)),
      highlight: stylingAttribute("highlight", Object.keys(highlights)),
    };
  },
  parseHTML() {
    return [
      {
        tag: "span",
        getAttrs: (element) =>
          element instanceof HTMLElement &&
          (element.hasAttribute("style") ||
            Array.from(element.classList).some((name) =>
              /^u2-(font|size|ink|highlight)-/.test(name),
            ))
            ? null
            : false,
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});

const superscript = Mark.create({
  name: "superscript",
  excludes: "subscript",
  parseHTML: () => [{ tag: "sup" }, { style: "vertical-align=super" }],
  renderHTML: () => ["sup", 0],
});

const subscript = Mark.create({
  name: "subscript",
  excludes: "superscript",
  parseHTML: () => [{ tag: "sub" }, { style: "vertical-align=sub" }],
  renderHTML: () => ["sub", 0],
});

export function safeWebLink(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    return ["http:", "https:", "mailto:"].includes(parsed.protocol)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export const documentExtensions = [
  StarterKit.configure({
    link: {
      openOnClick: false,
      linkOnPaste: true,
      isAllowedUri: (value) => safeWebLink(value) !== null,
    },
  }),
  BlockStyle,
  InlineStyle,
  superscript,
  subscript,
  TableKit.configure({ table: { resizable: true } }),
  CellStyles,
  DocumentImage,
  DocumentReference,
  DocumentPageLayout,
  PageBreak,
];

const schema = getSchema(documentExtensions);

/** Refuse unknown structures and newer formats before allowing edits. */
export function readDocument(content: string): JSONContent {
  const value = JSON.parse(content) as JSONContent;
  if (
    value?.type !== "doc" ||
    (value.attrs?.schemaVersion !== undefined &&
      value.attrs.schemaVersion !== 1)
  ) {
    throw new Error("Unsupported document format");
  }
  schema.nodeFromJSON(value).check();
  return value;
}
