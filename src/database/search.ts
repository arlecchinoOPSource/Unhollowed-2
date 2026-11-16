import { invoke } from "@tauri-apps/api/core";
import type { IssueSummary } from "./issues";

export interface ProjectHit {
  id: string;
  name: string;
  status: string;
}

export interface MilestoneHit {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  closed: boolean;
}

/** Up to eight results per group, with the total that matched. */
export interface SearchResults {
  projects: ProjectHit[];
  projectTotal: number;
  issues: IssueSummary[];
  issueTotal: number;
  milestones: MilestoneHit[];
  milestoneTotal: number;
}

export function searchWorkspace(text: string): Promise<SearchResults> {
  return invoke("search_workspace", { text });
}
