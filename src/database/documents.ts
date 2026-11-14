import { invoke } from "@tauri-apps/api/core";

export interface DocumentSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface WorkspaceDocument extends DocumentSummary {
  /** Tiptap JSON, stored as text. */
  content: string;
  createdAt: string;
}

export function listDocuments(): Promise<DocumentSummary[]> {
  return invoke("list_documents");
}

export function getDocument(id: string): Promise<WorkspaceDocument> {
  return invoke("get_document", { id });
}

export function createDocument(title?: string): Promise<WorkspaceDocument> {
  return invoke("create_document", { title });
}

export function updateDocument(
  id: string,
  title: string,
  content: string,
): Promise<WorkspaceDocument> {
  return invoke("update_document", { id, title, content });
}
