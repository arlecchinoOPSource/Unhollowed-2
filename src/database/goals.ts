import { invoke } from "./dataChanges";

export interface Mission {
  id: string;
  title: string;
  description: string;
}

/**
 * Progress over a deduplicated set of issues: linked issues and their
 * sub-issues in the same project, each counted once. `total` excludes
 * canceled issues. Blocked issues count in `total` but not in `completed`.
 */
export interface Rollup {
  total: number;
  completed: number;
  blocked: number;
  canceled: number;
}

export interface Objective extends Mission, Rollup {
  missionId: string | null;
}

export interface ProjectGoals {
  /** Each mission rolls up every issue of its objectives once. */
  missions: (Mission & Rollup)[];
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
