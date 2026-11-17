import { generateJSON } from "@tiptap/react";
import { unzipSync, zipSync } from "fflate";
import mammoth from "mammoth";
import { documentExtensions, safeWebLink } from "./schema";

const mib = 1024 * 1024;
const wordNamespace =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export async function importWordFile(file: File) {
  if (file.size > 16 * mib) throw new Error("Choose a Word file under 16 MiB.");
  let expanded = 0;
  let entries = 0;
  const parts = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter({ name, size, originalSize, compression }) {
      if (
        ++entries > 512 ||
        !Number.isSafeInteger(originalSize) ||
        originalSize < 0
      )
        throw new Error("This Word file exceeds the archive limits.");
      const bytes = compression === 0 ? size : originalSize;
      expanded += bytes;
      if (
        !Number.isSafeInteger(expanded) ||
        expanded > 32 * mib ||
        bytes > 8 * mib
      )
        throw new Error("This Word file exceeds the archive limits.");
      return (
        (name.startsWith("word/") ||
          name === "_rels/.rels" ||
          name === "[Content_Types].xml") &&
        !name.split("/").some((part) => part === "..")
      );
    },
  });
  if (!parts["word/document.xml"] || !parts["[Content_Types].xml"])
    throw new Error("The selected file does not contain a Word document.");
  // Pass only the bounded, decoded parts to the converter.
  const archive = zipSync(parts, { level: 0 });
  const images: Record<string, string> = {};
  let imageCount = 0;
  let imageBytes = 0;
  let omittedImages = false;
  const conversion = await mammoth.convertToHtml(
    { arrayBuffer: archive.buffer },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      ignoreEmptyParagraphs: false,
      styleMap: ["u => u", "strike => s"],
      convertImage: mammoth.images.imgElement(async (image) => {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(image.contentType)) {
          omittedImages = true;
          return { src: "" };
        }
        const data = await image.readAsBase64String();
        imageBytes += data.length;
        if (
          ++imageCount > 64 ||
          imageBytes > 28 * mib ||
          data.length > Math.ceil((8 * mib) / 3) * 4
        )
          throw new Error(
            "This Word file contains too many or oversized images.",
          );
        const key = `word-image-${imageCount}`;
        images[key] = data;
        return { src: key };
      }),
    },
  );
  if (conversion.messages.some((message) => message.type === "error"))
    throw new Error(
      "Word conversion could not read all of the document content.",
    );
  const body = document.createElement("template");
  body.innerHTML = conversion.value;
  for (const link of body.content.querySelectorAll("a")) {
    const href = safeWebLink(link.getAttribute("href") ?? "");
    if (href) link.setAttribute("href", href);
    else link.replaceWith(...link.childNodes);
  }
  for (const image of body.content.querySelectorAll("img")) {
    const key = image.getAttribute("src") ?? "";
    const alt = (image.getAttribute("alt") ?? "").slice(0, 200);
    if (!Object.hasOwn(images, key)) {
      image.replaceWith(alt);
      continue;
    }
    const figure = body.content.ownerDocument.createElement("figure");
    figure.setAttribute("data-u2-image", "");
    figure.setAttribute("assetid", key);
    figure.setAttribute("alt", alt);
    // A managed image is a block. Close and reopen the paragraph around it.
    const paragraph = image.closest("p");
    if (!paragraph) {
      image.replaceWith(figure);
      continue;
    }
    const range = body.content.ownerDocument.createRange();
    range.setStartAfter(image);
    range.setEnd(paragraph, paragraph.childNodes.length);
    const trailing = paragraph.cloneNode(false) as HTMLElement;
    trailing.appendChild(range.extractContents());
    image.remove();
    paragraph.after(figure, trailing);
    if (!paragraph.textContent && !paragraph.querySelector("img"))
      paragraph.remove();
    if (!trailing.textContent && !trailing.querySelector("img"))
      trailing.remove();
  }
  const content = generateJSON(body.innerHTML, documentExtensions);
  const xml = new DOMParser().parseFromString(
    new TextDecoder().decode(parts["word/document.xml"]),
    "application/xml",
  );
  const size = xml.getElementsByTagNameNS(wordNamespace, "pgSz")[0];
  const margin = xml.getElementsByTagNameNS(wordNamespace, "pgMar")[0];
  if (size) {
    const mm = (value: string | null) => (Number(value) * 25.4) / 1440;
    const width = mm(size.getAttributeNS(wordNamespace, "w"));
    const height = mm(size.getAttributeNS(wordNamespace, "h"));
    const long = Math.max(width, height);
    const paper =
      Math.abs(long - 355.6) < 2
        ? "legal"
        : Math.abs(long - 279.4) < 2
          ? "letter"
          : "a4";
    content.attrs = {
      ...content.attrs,
      pageLayout: {
        paper,
        landscape:
          width > height ||
          size.getAttributeNS(wordNamespace, "orient") === "landscape",
        margin:
          Math.round(
            mm(margin?.getAttributeNS(wordNamespace, "left") ?? null) * 10,
          ) / 10 || 25.4,
      },
    };
  }
  return {
    content,
    images,
    warning: omittedImages
      ? "Imported Word document. Unsupported image formats were omitted."
      : "Imported Word document. Review pagination and any advanced formatting.",
  };
}
