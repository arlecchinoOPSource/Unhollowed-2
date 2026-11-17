import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/react";
import { readDocument } from "./schema";

const nativeFormat = "unhollowed-document";
const maxImageBytes = 28 * 1024 * 1024;
export const maxNativeBytes = 32 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function imageIds(content: JSONContent) {
  const ids = new Set<string>();
  function visit(node: JSONContent) {
    if (node.type === "localImage") {
      const id = node.attrs?.assetId;
      if (typeof id !== "string" || !id.length || id.length > 120)
        throw new Error("The document contains an invalid image reference.");
      ids.add(id);
    }
    node.content?.forEach(visit);
  }
  visit(content);
  if (ids.size > 64)
    throw new Error("An Unhollowed file can contain up to 64 images.");
  return ids;
}

export async function readNativeFile(file: File) {
  if (file.size > maxNativeBytes)
    throw new Error("Choose an Unhollowed file under 32 MiB.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await file.arrayBuffer(),
  );
  const data: unknown = JSON.parse(text);
  if (
    !isRecord(data) ||
    data.format !== nativeFormat ||
    data.version !== 1 ||
    typeof data.title !== "string" ||
    !isRecord(data.content) ||
    !isRecord(data.images)
  )
    throw new Error(
      "This Unhollowed document file is damaged or uses an unsupported format.",
    );
  const title = data.title.trim() || "Untitled";
  if (Array.from(title).length > 200)
    throw new Error("The document title exceeds 200 characters.");
  const content = readDocument(JSON.stringify(data.content));
  const ids = imageIds(content);
  if (Object.keys(data.images).length !== ids.size)
    throw new Error(
      "The file's image references do not match its embedded images.",
    );
  let size = 0;
  const images = Object.create(null) as Record<string, string>;
  for (const id of ids) {
    const image = data.images[id];
    if (!Object.hasOwn(data.images, id) || typeof image !== "string")
      throw new Error("An embedded image is missing from the file.");
    size += image.length;
    if (size > maxImageBytes)
      throw new Error("Embedded images exceed the Unhollowed file limit.");
    images[id] = image;
  }
  return { title, content, images, warning: undefined };
}

export async function exportNativeFile(
  content: JSONContent,
  id: string,
  title: string,
) {
  const images = Object.create(null) as Record<string, string>;
  let size = 0;
  for (const image of imageIds(content)) {
    const { data } = await invoke<{ data: string }>("get_document_image", {
      documentId: id,
      id: image,
    });
    size += data.length;
    if (size > maxImageBytes)
      throw new Error("Embedded images exceed the Unhollowed file limit.");
    images[image] = data;
  }
  return JSON.stringify({
    format: nativeFormat,
    version: 1,
    title,
    content,
    images,
  });
}
