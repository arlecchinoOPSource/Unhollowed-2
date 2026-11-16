import { invoke } from "@tauri-apps/api/core";

export interface Mission {
  id: string;
  title: string;
  description: string;
}

export interface Objective extends Mission {
  missionId: string | null;
  total: number;
  completed: number;
}

export interface ProjectGoals {
  missions: Mission[];
  objectives: Objective[];
  links: [objectiveId: string, issueId: string][];
}

export function listProjectGoals(projectId: string): Promise<ProjectGoals> {
  return invoke("list_project_goals", { projectId });
}

export function saveProjectMission(
  projectId: string,
  id: string | null,
  input: Omit<Mission, "id">,
): Promise<void> {
  return invoke("save_project_mission", { projectId, id, input });
}

export function saveProjectObjective(
  projectId: string,
  id: string | null,
  input: Omit<Mission, "id"> & { missionId: string | null; issueIds: string[] },
): Promise<void> {
  return invoke("save_project_objective", { projectId, id, input });
}

export function goalError(cause: unknown): string {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? cause.code
      : null;
  switch (code) {
    case "not_found":
      return "This project or goal is unavailable.";
    case "invalid_title":
      return "Enter a title of 1 to 200 characters.";
    case "invalid_description":
      return "Enter a description of up to 5,000 characters.";
    case "invalid_link":
      return "Select missions and issues that belong to this project.";
    default:
      return "Could not access project goals. Try again.";
  }
}
