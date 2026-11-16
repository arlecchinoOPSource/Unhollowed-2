import { invoke } from "@tauri-apps/api/core";

export interface LinkedDocument {
  id: string;
  title: string;
  updatedAt: string;
}

export interface LinkingIssue {
  id: string;
  number: number;
  title: string;
}

export interface InheritedDocument extends LinkedDocument {
  /** The project's issues that link this document. */
  issues: LinkingIssue[];
}

export interface ProjectDocuments {
  /** Linked to the project itself. */
  direct: LinkedDocument[];
  /** Linked only through the project's issues. */
  viaIssues: InheritedDocument[];
}

export interface DocumentUsage {
  issues: LinkingIssue[];
  projects: { id: string; name: string }[];
}

export function listIssueDocuments(issueId: string): Promise<LinkedDocument[]> {
  return invoke("list_issue_documents", { issueId });
}

export function linkIssueDocument(
  issueId: string,
  documentId: string,
): Promise<LinkedDocument[]> {
  return invoke("link_issue_document", { issueId, documentId });
}

export function unlinkIssueDocument(
  issueId: string,
  documentId: string,
): Promise<LinkedDocument[]> {
  return invoke("unlink_issue_document", { issueId, documentId });
}

export function listProjectDocuments(
  projectId: string,
): Promise<ProjectDocuments> {
  return invoke("list_project_documents", { projectId });
}

export function linkProjectDocument(
  projectId: string,
  documentId: string,
): Promise<ProjectDocuments> {
  return invoke("link_project_document", { projectId, documentId });
}

export function unlinkProjectDocument(
  projectId: string,
  documentId: string,
): Promise<ProjectDocuments> {
  return invoke("unlink_project_document", { projectId, documentId });
}

export function getDocumentUsage(documentId: string): Promise<DocumentUsage> {
  return invoke("get_document_usage", { documentId });
}

export function linkError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  switch (code) {
    case "not_found":
      return "This item is unavailable in the current workspace.";
    case "document_not_found":
      return "That document is unavailable in the current workspace.";
    default:
      return "Could not access local document links. Try again.";
  }
}
