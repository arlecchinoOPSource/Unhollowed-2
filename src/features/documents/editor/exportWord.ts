import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from "docx";
import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/react";
import { paperSizes, readLayout } from "./pageLayout";
import { fonts, safeWebLink, sizes } from "./schema";

const twips = (mm: number) => Math.round((mm * 1440) / 25.4);
const colors = {
  red: "9A2032",
  blue: "2447A5",
  green: "216449",
  purple: "6A348E",
};
const highlights = { yellow: "FBF1AA", mint: "CBEDDC", pink: "FBD4E4" };
const headings = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

function option<T>(values: Record<string, T>, key: unknown) {
  return typeof key === "string" && Object.hasOwn(values, key)
    ? values[key]
    : undefined;
}

function textRun(node: JSONContent): ParagraphChild {
  if (node.type === "hardBreak") return new TextRun({ break: 1 });
  const marks = new Map(
    (node.marks ?? []).map((mark) => [mark.type, mark.attrs]),
  );
  const inline = marks.get("documentInlineStyle");
  const shade = option(highlights, inline?.highlight);
  const link = safeWebLink(String(marks.get("link")?.href ?? ""));
  const run = new TextRun({
    text: node.text ?? "",
    bold: marks.has("bold"),
    italics: marks.has("italic"),
    underline: marks.has("underline") || link ? {} : undefined,
    strike: marks.has("strike"),
    superScript: marks.has("superscript"),
    subScript: marks.has("subscript"),
    font: option(fonts, inline?.font),
    size: sizes.includes(Number(inline?.size))
      ? Number(inline?.size) * 2
      : undefined,
    color: option(colors, inline?.ink) ?? (link ? "2447A5" : undefined),
    shading: shade ? { fill: shade } : undefined,
  });
  return link ? new ExternalHyperlink({ link, children: [run] }) : run;
}

function horizontal(size: unknown) {
  return size === "small" ? 360 : size === "large" ? 720 : undefined;
}
function vertical(size: unknown) {
  return size === "small"
    ? 120
    : size === "large"
      ? 240
      : size === "none"
        ? 0
        : undefined;
}

async function wordImage(
  node: JSONContent,
  id: string,
  maxWidth: number,
  maxHeight: number,
  countBytes: (encoded: string) => void,
) {
  const { mime, data } = await invoke<{ mime: string; data: string }>(
    "get_document_image",
    {
      documentId: id,
      id: node.attrs?.assetId,
    },
  );
  if (!/^image\/(png|jpeg|gif|webp)$/.test(mime))
    throw new Error("A document image could not be exported.");
  countBytes(data);
  const image = new Image();
  image.src = `data:${mime};base64,${data}`;
  await image.decode();
  const fraction =
    node.attrs?.width === "small"
      ? 0.25
      : node.attrs?.width === "medium"
        ? 0.5
        : 1;
  const width = Math.max(
    1,
    Math.min(
      image.naturalWidth,
      maxWidth * fraction,
      (maxHeight * image.naturalWidth) / image.naturalHeight,
    ),
  );
  const height = Math.max(
    1,
    Math.round((width * image.naturalHeight) / image.naturalWidth),
  );
  const transformation = { width: Math.round(width), height };
  const altText = {
    name: "Document image",
    title: "",
    description: String(node.attrs?.alt ?? ""),
  };
  if (mime === "image/webp") {
    const canvas = document.createElement("canvas");
    canvas.width = transformation.width;
    canvas.height = transformation.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This WebP image could not be converted.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return new ImageRun({
      type: "png",
      data: canvas.toDataURL(),
      transformation,
      altText,
    });
  }
  const type =
    mime === "image/jpeg" ? "jpg" : mime === "image/gif" ? "gif" : "png";
  return new ImageRun({ type, data: image.src, transformation, altText });
}

export async function exportWordFile(
  content: JSONContent,
  id: string,
  title: string,
) {
  const layout = readLayout(content.attrs?.pageLayout);
  const [width, height] = paperSizes[layout.paper].dimensions;
  const margin = twips(layout.margin);
  const availableWidth =
    (((layout.landscape ? height : width) - 2 * layout.margin) * 96) / 25.4;
  const numbering: {
    reference: string;
    levels: {
      level: number;
      format: typeof LevelFormat.DECIMAL;
      text: string;
      start: number;
    }[];
  }[] = [];
  const availableHeight =
    (((layout.landscape ? width : height) - 2 * layout.margin) * 96) / 25.4;
  let imageCount = 0;
  let encodedBytes = 0;
  function countImageBytes(encoded: string) {
    encodedBytes += encoded.length;
    if (encodedBytes > 28 * 1024 * 1024)
      throw new Error("Embedded images exceed the Word export limit.");
  }
  async function blocks(
    nodes: JSONContent[],
    depth = 0,
  ): Promise<(Paragraph | Table)[]> {
    const converted: (Paragraph | Table)[] = [];
    for (const node of nodes) {
      const children = node.content ?? [];
      const attrs = node.attrs;
      if (node.type === "table") {
        const rows: TableRow[] = [];
        for (const row of children) {
          const cells: TableCell[] = [];
          for (const cell of row.content ?? []) {
            cells.push(
              new TableCell({
                children: await blocks(cell.content ?? []),
                columnSpan: cell.attrs?.colspan,
                rowSpan: cell.attrs?.rowspan,
                shading: cell.attrs?.shade
                  ? {
                      fill: cell.attrs.shade === "accent" ? "E8EAFD" : "F0F0F0",
                    }
                  : undefined,
              }),
            );
          }
          rows.push(
            new TableRow({
              children: cells,
              tableHeader:
                row.content?.every((cell) => cell.type === "tableHeader") ||
                undefined,
            }),
          );
        }
        if (rows.length)
          converted.push(
            new Table({
              rows,
              width: { size: 100, type: WidthType.PERCENTAGE },
            }),
          );
      } else if (node.type === "orderedList" || node.type === "bulletList") {
        const level = Math.min(depth, 8);
        const reference = `list-${numbering.length}`;
        if (node.type === "orderedList")
          numbering.push({
            reference,
            levels: [
              {
                level,
                format: LevelFormat.DECIMAL,
                text: `%${level + 1}.`,
                start: Number(attrs?.start ?? 1),
              },
            ],
          });
        for (const item of children) {
          const [first, ...rest] = item.content ?? [];
          converted.push(
            new Paragraph({
              children: first?.content?.map(textRun),
              ...(node.type === "bulletList"
                ? { bullet: { level } }
                : { numbering: { level, reference } }),
            }),
          );
          converted.push(...(await blocks(rest, depth + 1)));
        }
      } else if (node.type === "localImage") {
        if (++imageCount > 64)
          throw new Error("Export supports up to 64 embedded images.");
        const alignment =
          option(
            {
              left: AlignmentType.LEFT,
              center: AlignmentType.CENTER,
              right: AlignmentType.RIGHT,
            },
            attrs?.alignment,
          ) ?? AlignmentType.CENTER;
        converted.push(
          new Paragraph({
            alignment,
            children: [
              await wordImage(
                node,
                id,
                availableWidth,
                availableHeight,
                countImageBytes,
              ),
            ],
          }),
        );
        if (attrs?.caption)
          converted.push(
            new Paragraph({ alignment, text: String(attrs.caption) }),
          );
      } else if (node.type === "pageBreak") {
        converted.push(new Paragraph({ children: [new PageBreak()] }));
      } else if (node.type === "horizontalRule") {
        converted.push(
          new Paragraph({
            border: {
              bottom: { color: "808080", style: BorderStyle.SINGLE, size: 4 },
            },
          }),
        );
      } else if (node.type === "blockquote") {
        for (const child of children) {
          converted.push(
            new Paragraph({
              children: child.content?.map(textRun),
              indent: { left: 480 },
            }),
          );
        }
      } else if (
        node.type === "paragraph" ||
        node.type === "heading" ||
        node.type === "codeBlock"
      ) {
        const options: IParagraphOptions = {
          heading:
            node.type === "heading"
              ? headings[Number(attrs?.level) - 1]
              : undefined,
          alignment: option(
            {
              left: AlignmentType.LEFT,
              center: AlignmentType.CENTER,
              right: AlignmentType.RIGHT,
              justify: AlignmentType.JUSTIFIED,
            },
            attrs?.align,
          ),
          spacing: {
            before: vertical(attrs?.before),
            after: vertical(attrs?.after),
            line: option(
              { single: 240, relaxed: 360, double: 480 },
              attrs?.leading,
            ),
          },
          indent: {
            left: horizontal(attrs?.left),
            right: horizontal(attrs?.right),
            firstLine: attrs?.first === "indent" ? 360 : undefined,
            hanging: attrs?.first === "hanging" ? 360 : undefined,
          },
          children:
            node.type === "codeBlock"
              ? children.flatMap((child) =>
                  (child.text ?? "").split("\n").map(
                    (text, i) =>
                      new TextRun({
                        text,
                        font: "Courier New",
                        break: i ? 1 : 0,
                      }),
                  ),
                )
              : children.map(textRun),
        };
        converted.push(new Paragraph(options));
      }
    }
    return converted;
  }

  const children = await blocks(content.content ?? []);
  const file = new Document({
    title,
    numbering: { config: numbering },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: twips(width),
              height: twips(height),
              orientation: layout.landscape
                ? PageOrientation.LANDSCAPE
                : PageOrientation.PORTRAIT,
            },
            margin: {
              top: margin,
              bottom: margin,
              left: margin,
              right: margin,
            },
          },
        },
        headers: layout.header
          ? {
              default: new Header({
                children: [new Paragraph({ text: layout.header })],
              }),
            }
          : undefined,
        footers:
          layout.footer || layout.numbers
            ? {
                default: new Footer({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun(layout.footer),
                        ...(layout.numbers
                          ? [new TextRun({ children: [PageNumber.CURRENT] })]
                          : []),
                      ],
                    }),
                  ],
                }),
              }
            : undefined,
        children: children.length ? children : [new Paragraph("")],
      },
    ],
  });
  return Packer.toBase64String(file);
}
