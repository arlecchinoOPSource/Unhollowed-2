import { invoke } from "./dataChanges";
import type { IssueStatus } from "./issues";

export const relationKinds = {
  parent: "Parent issue",
  child: "Sub-issue",
  blocks: "Blocks",
  blocked_by: "Blocked by",
  related: "Related issue",
} as const;

export type RelationKind = keyof typeof relationKinds;
export interface IssueRelationship {
  id: string;
  number: number;
  title: string;
  status: IssueStatus;
  /** Archived issues stay linked and are marked as archived. */
  archived: boolean;
  kind: RelationKind;
}

export function listRelationships(id: string): Promise<IssueRelationship[]> {
  return invoke("list_issue_relationships", { id });
}

export function addRelationship(
  id: string,
  otherId: string,
  kind: RelationKind,
): Promise<void> {
  return invoke("add_issue_relationship", { id, otherId, kind });
}

export function removeRelationship(
  id: string,
  otherId: string,
  kind: RelationKind,
): Promise<void> {
  return invoke("remove_issue_relationship", { id, otherId, kind });
}

export function relationError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  switch (code) {
    case "cycle":
      return "This link would create a cycle.";
    case "self_link":
      return "An issue cannot link to itself.";
    case "duplicate":
      return "This relationship already exists.";
    case "already_has_parent":
      return "This sub-issue already has a parent. Remove that link first.";
    case "not_found":
      return "One of these issues is unavailable in this workspace.";
    default:
      return "Could not access issue relationships. Try again.";
  }
}
