import { invoke } from "@tauri-apps/api/core";

/** The configuration version this build writes. */
export const VIEW_CONFIG_VERSION = 1;

/**
 * Stored list filters, version 1. Values match the list's URL filters, so
 * relative rules such as `due: "overdue"` stay relative. Empty strings mean
 * "any".
 */
export interface ViewFilters {
  state: string;
  text: string;
  status: string;
  priority: string;
  project: string;
  due: string;
  labels: string[];
  labelMatch: string;
  milestone: string;
  sort: string;
  direction: string;
}

export interface ViewConfig {
  version: number;
  view: "list" | "board";
  filters: ViewFilters;
}

export interface SavedView {
  id: string;
  name: string;
  config: ViewConfig;
  createdAt: string;
  updatedAt: string;
}

export function listSavedViews(): Promise<SavedView[]> {
  return invoke("list_saved_views");
}

export function createSavedView(
  name: string,
  config: ViewConfig,
): Promise<SavedView> {
  return invoke("create_saved_view", { name, config });
}

export function updateSavedView(
  id: string,
  name: string,
  config: ViewConfig,
): Promise<SavedView> {
  return invoke("update_saved_view", { id, name, config });
}

export function deleteSavedView(id: string): Promise<void> {
  return invoke("delete_saved_view", { id });
}

export function viewError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  switch (code) {
    case "not_found":
      return "This saved view is no longer available.";
    case "invalid_name":
      return "Enter a view name of 1 to 80 characters.";
    case "duplicate_name":
      return "Another saved view already has this name.";
    case "invalid_config":
      return "These filters cannot be saved in a view.";
    default:
      return "Could not access local saved views. Try again.";
  }
}
