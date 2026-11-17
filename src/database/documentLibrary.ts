import { invoke } from "@tauri-apps/api/core";
import type { DocumentSummary } from "./documents";
import type { JSONContent } from "@tiptap/react";

export interface LibraryDocument extends DocumentSummary {
  folderId: string | null;
  favorite: boolean;
  archivedAt: string | null;
  openedAt: string | null;
  createdAt: string;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
}

export function loadLibrary(): Promise<{
  documents: LibraryDocument[];
  folders: Folder[];
}> {
  return invoke("list_document_library");
}

export function createFolder(
  name: string,
  parentId: string | null,
): Promise<Folder> {
  return invoke("create_document_folder", { name, parentId });
}

export function addLibraryDocument(
  title: string,
  content: JSONContent | null,
  folder: string | null,
  images?: Record<string, string>,
): Promise<LibraryDocument> {
  return invoke("create_library_document", {
    title,
    content: content ? JSON.stringify(content) : null,
    folder,
    images,
  });
}

export type LibraryChange =
  | { kind: "archive" | "restore" | "open" }
  | { kind: "favorite"; value: boolean }
  | { kind: "move"; folder: string | null };

export function updateLibraryDocument(
  id: string,
  input: LibraryChange,
): Promise<LibraryDocument> {
  return invoke("change_document_library", { id, input });
}

export function duplicateDocument(id: string): Promise<LibraryDocument> {
  return invoke("duplicate_document", { id });
}
