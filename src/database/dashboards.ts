import { invoke } from "@tauri-apps/api/core";

/** The layout version this build writes and reads. */
export const LAYOUT_VERSION = 1;

/**
 * A stored dashboard. `layout` is whatever was written, untouched, so the
 * webview can recover from a layout it does not understand without losing it
 * (see `readLayout`). docs/ANALYTICS.md, "Dashboard layouts".
 */
export interface DashboardRecord {
  id: string;
  name: string;
  position: number;
  layoutVersion: number;
  layout: unknown;
  createdAt: string;
  updatedAt: string;
}

export const listDashboards = (): Promise<DashboardRecord[]> =>
  invoke("list_dashboards");

/** Creates a dashboard (`id` null) or replaces one's name and layout. */
export const saveDashboard = (
  id: string | null,
  name: string,
  layout: unknown,
): Promise<DashboardRecord> => invoke("save_dashboard", { id, name, layout });

export const deleteDashboard = (id: string): Promise<void> =>
  invoke("delete_dashboard", { id });

export function dashboardError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  switch (code) {
    case "duplicate_name":
      return "Another dashboard already has this name.";
    case "invalid_name":
      return "Enter a name of up to 80 characters.";
    case "newer_layout":
      return "This dashboard was saved by a newer version of the app and is left unchanged.";
    case "too_many":
      return "You have reached the most dashboards allowed.";
    case "not_found":
      return "That dashboard is no longer available.";
    default:
      return "Could not read or save dashboards. Try again.";
  }
}
