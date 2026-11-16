import { invoke } from "@tauri-apps/api/core";
import type { IssueQuery } from "./issues";

/** Where a file was saved and how many records it holds. */
export interface SavedFile {
  path: string;
  records: number;
}

/** What an import creates or repairs. A preview returns the same report. */
export interface ImportReport {
  projects: number;
  labelsCreated: number;
  labelsReused: string[];
  milestones: number;
  missions: number;
  objectives: number;
  issues: number;
  relationships: number;
  /** Original key to new key, in original number order. */
  renumbered: [string, string][];
  skippedLabelLinks: number;
  completionRepaired: number;
}

/** The largest file the import accepts, matching the backend limit. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** Saves every project and issue as JSON. `null` when the user cancels. */
export function exportProjectData(): Promise<SavedFile | null> {
  return invoke("export_project_data");
}

/** Saves the issues matching `query` as CSV. `null` when the user cancels. */
export function exportIssuesCsv(query: IssueQuery): Promise<SavedFile | null> {
  return invoke("export_issues_csv", { query });
}

/** Runs the import and rolls it back, reporting what it would do. */
export function previewImport(content: string): Promise<ImportReport> {
  return invoke("preview_import", { content });
}

export function importProjectData(content: string): Promise<ImportReport> {
  return invoke("import_project_data", { content });
}

/** A readable message for a failed export or import. */
export function portabilityError(cause: unknown): string {
  const error = cause as {
    code?: string;
    detail?: string;
    problems?: string[];
    total?: number;
  };
  switch (error?.code) {
    case "unreadable_file":
      return `This file could not be read as an Unhollowed export. ${error.detail ?? ""}`.trim();
    case "invalid_file": {
      const problems = error.problems ?? [];
      const more = (error.total ?? problems.length) - problems.length;
      return [
        "This file has problems, so nothing was imported:",
        ...problems.map((problem) => `• ${problem}`),
        ...(more > 0 ? [`…and ${more} more.`] : []),
      ].join("\n");
    }
    case "too_large":
      return "This file is larger than 50 MB, so it was not imported.";
    case "invalid_filter":
      return "These filters are not valid, so nothing was exported.";
    case "write_failed":
      return "Could not write the file. Check the location and try again.";
    case "database_unavailable":
    case "workspace_read_failed":
      return "Could not open the workspace database.";
    default:
      return "Something went wrong while reading or writing your data.";
  }
}
