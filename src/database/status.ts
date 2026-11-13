import { invoke, isTauri } from "@tauri-apps/api/core";

export interface DatabaseStatus {
  workspaceId: string;
  workspaceName: string;
}

export function readDatabaseStatus(): Promise<DatabaseStatus> {
  return invoke("database_status");
}

export { isTauri };
