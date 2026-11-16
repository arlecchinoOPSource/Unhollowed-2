import { invoke } from "@tauri-apps/api/core";

export const projectStatuses = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  archived: "Archived",
} as const;

export type ProjectStatus = keyof typeof projectStatuses;

export interface ProjectInput {
  name: string;
  description: string | null;
  startDate: string | null;
  targetDate: string | null;
}

export interface Project extends ProjectInput {
  id: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export function listProjects(): Promise<Project[]> {
  return invoke("list_projects");
}

export function getProject(id: string): Promise<Project> {
  return invoke("get_project", { id });
}

export function createProject(input: ProjectInput): Promise<Project> {
  return invoke("create_project", { input });
}

export function updateProject(
  id: string,
  input: ProjectInput,
): Promise<Project> {
  return invoke("update_project", { id, input });
}

export function changeProjectStatus(
  id: string,
  status: ProjectStatus,
): Promise<Project> {
  return status === "archived"
    ? invoke("archive_project", { id })
    : invoke("change_project_status", { id, status });
}

export function projectError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  switch (code) {
    case "not_found":
      return "This project is unavailable in the current workspace.";
    case "invalid_name":
      return "Enter a project name of 1 to 200 characters.";
    case "invalid_description":
      return "Enter a description of up to 5,000 characters.";
    case "invalid_date":
      return "Enter valid dates.";
    case "invalid_date_range":
      return "The target date must be on or after the start date.";
    default:
      return "Could not access local project storage. Try again.";
  }
}
