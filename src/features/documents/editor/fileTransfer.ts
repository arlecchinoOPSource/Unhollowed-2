import { invoke } from "@tauri-apps/api/core";
import { generateJSON, type Editor, type JSONContent } from "@tiptap/react";
import { documentExtensions, readDocument, safeWebLink } from "./schema";
import { pageCss, readLayout } from "./pageLayout";
import wordCss from "./word.css?raw";

export type ExportFormat = "txt" | "md" | "html" | "docx" | "u2doc";
const maxImportBytes = 512 * 1024;
const maxExportSize = 32 * 1024 * 1024;

export async function readWritingFile(file: File) {
  if (/\.u2doc$/i.test(file.name)) {
    const { readNativeFile } = await import("./nativeFile");
    return readNativeFile(file);
  }
  const extension = /\.(txt|md|markdown|docx)$/i.exec(file.name);
  if (!extension)
    throw new Error(
      "Choose an Unhollowed, Word, Markdown, or plain text file.",
    );
  const title = Array.from(
    file.name.slice(0, -extension[0].length).trim() || "Untitled",
  )
    .slice(0, 200)
    .join("");
  if (extension[1].toLowerCase() === "docx") {
    const { importWordFile } = await import("./importWord");
    const result = await importWordFile(file);
    return {
      ...result,
      title,
      content: readDocument(JSON.stringify(result.content)),
    };
  }
  if (file.size > maxImportBytes)
    throw new Error("Choose a file under 512 KiB.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await file.arrayBuffer(),
  );
  const warnings: string[] = [];
  let content: JSONContent;
  if (extension[1].toLowerCase() === "txt") {
    content = {
      type: "doc",
      content: text.split(/\r\n?|\n/).map((line) => ({
        type: "paragraph",
        ...(line.length ? { content: [{ type: "text", text: line }] } : {}),
      })),
    };
  } else {
    const { default: MarkdownIt } = await import("markdown-it");
    const markdown = new MarkdownIt({ html: false });
    markdown.renderer.rules.image = (tokens, index) => {
      warnings.push(
        "Markdown image references were imported as alternative text.",
      );
      return markdown.utils.escapeHtml(tokens[index].content);
    };
    content = generateJSON(markdown.render(text), documentExtensions);
  }
  return {
    title,
    content: readDocument(JSON.stringify(content)),
    warning: warnings[0],
    images: undefined,
  };
}

function exportBody(editor: Editor) {
  const template = document.createElement("template");
  template.innerHTML = editor.getHTML();
  for (const link of template.content.querySelectorAll("a")) {
    const href = safeWebLink(link.getAttribute("href") ?? "");
    if (href && !link.hasAttribute("data-document-target")) {
      link.setAttribute("href", href);
      link.setAttribute("rel", "noopener noreferrer");
    } else {
      link.replaceWith(...link.childNodes);
    }
  }
  return template;
}

async function exportHtml(editor: Editor, id: string, title: string) {
  const body = exportBody(editor);
  const owner = body.content.ownerDocument;
  let imageSize = 0;
  for (const figure of body.content.querySelectorAll<HTMLElement>(
    "figure[data-u2-image]",
  )) {
    const asset = figure.getAttribute("assetid");
    if (!asset) throw new Error("An image reference is missing.");
    const { mime, data } = await invoke<{ mime: string; data: string }>(
      "get_document_image",
      { documentId: id, id: asset },
    );
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime))
      throw new Error("An image format could not be exported.");
    imageSize += data.length;
    if (imageSize > maxExportSize)
      throw new Error("Embedded images exceed the 32 MiB export limit.");
    const img = owner.createElement("img");
    img.setAttribute("src", `data:${mime};base64,${data}`);
    img.setAttribute("alt", figure.getAttribute("alt") ?? "");
    const width = figure.getAttribute("width");
    figure.style.width =
      width === "small" ? "25%" : width === "medium" ? "50%" : "100%";
    const align = figure.getAttribute("alignment");
    figure.style.marginInline =
      align === "left" ? "0 auto" : align === "right" ? "auto 0" : "auto";
    figure.prepend(img);
    for (const attribute of [
      "assetid",
      "alt",
      "width",
      "alignment",
      "caption",
      "data-u2-image",
    ])
      figure.removeAttribute(attribute);
  }
  const safeTitle = owner.createElement("title");
  safeTitle.textContent = title;
  const styles = `:root { --interface: system-ui, sans-serif; --accent: #4c5ecd; --line: #dfdee4; --surface: #fff; --selection: #e8eafd; }
body { margin: 2rem auto; padding: 0 1rem; max-width: 52rem; font-family: system-ui, sans-serif; }
img { max-width: 100%; } pre { white-space: pre-wrap; }
${wordCss}
${pageCss(readLayout(editor.state.doc.attrs.pageLayout))}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
${safeTitle.outerHTML}<style>${styles}</style></head>
<body class="document-editor"><main class="ProseMirror">${body.innerHTML}</main></body></html>`;
}

async function exportMarkdown(editor: Editor) {
  const [{ default: Turndown }, { gfm }] = await Promise.all([
    import("turndown"),
    import("turndown-plugin-gfm"),
  ]);
  const body = exportBody(editor);
  for (const image of body.content.querySelectorAll<HTMLElement>(
    "figure[data-u2-image]",
  ))
    image.replaceWith(image.textContent ?? "");
  return new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" })
    .use(gfm)
    .turndown(body.innerHTML);
}

export async function saveWritingFile(
  editor: Editor,
  id: string,
  title: string,
  format: ExportFormat,
) {
  if (format === "docx") {
    const { exportWordFile } = await import("./exportWord");
    const content = await exportWordFile(editor.getJSON(), id, title);
    if (content.length > maxExportSize)
      throw new Error("This document exceeds the 32 MiB export limit.");
    return invoke<string | null>("save_document_file", {
      title,
      format,
      content,
    });
  }
  const content =
    format === "txt"
      ? editor.getText({ blockSeparator: "\n" })
      : format === "md"
        ? await exportMarkdown(editor)
        : format === "u2doc"
          ? await (
              await import("./nativeFile")
            ).exportNativeFile(editor.getJSON(), id, title)
          : await exportHtml(editor, id, title);
  if (new TextEncoder().encode(content).length > maxExportSize)
    throw new Error("This document exceeds the 32 MiB export limit.");
  return invoke<string | null>("save_document_file", {
    title,
    format,
    content,
  });
}
