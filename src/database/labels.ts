import { invoke } from "@tauri-apps/api/core";

/**
 * Label colors. Each swatch has a light and a dark theme value with at least
 * 3:1 contrast against that theme's surface. Badges always show the label's
 * name, so color is never the only cue.
 */
export const labelColors = {
  gray: { name: "Gray", light: "#6b7280", dark: "#a5adb8" },
  red: { name: "Red", light: "#d03a3a", dark: "#ff7b72" },
  orange: { name: "Orange", light: "#c2570c", dark: "#f6a05a" },
  yellow: { name: "Yellow", light: "#a16207", dark: "#e3c35b" },
  green: { name: "Green", light: "#2f8a3e", dark: "#6fd08a" },
  teal: { name: "Teal", light: "#0f7f86", dark: "#4fd1d9" },
  blue: { name: "Blue", light: "#2f63d6", dark: "#7aa7ff" },
  purple: { name: "Purple", light: "#7e4fd1", dark: "#b799ff" },
  pink: { name: "Pink", light: "#c23a86", dark: "#ff85c0" },
} as const;

export type LabelColor = keyof typeof labelColors;

export interface LabelInput {
  name: string;
  description: string | null;
  color: LabelColor;
}

export interface Label extends LabelInput {
  id: string;
  archived: boolean;
  archivedAt: string | null;
  /** Issues carrying the label, including closed ones. */
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export function listLabels(): Promise<Label[]> {
  return invoke("list_labels");
}

export function createLabel(input: LabelInput): Promise<Label> {
  return invoke("create_label", { input });
}

export function updateLabel(id: string, input: LabelInput): Promise<Label> {
  return invoke("update_label", { id, input });
}

export function archiveLabel(id: string): Promise<Label> {
  return invoke("archive_label", { id });
}

export function restoreLabel(id: string): Promise<Label> {
  return invoke("restore_label", { id });
}

export function labelError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  switch (code) {
    case "not_found":
      return "This label is unavailable in the current workspace.";
    case "invalid_name":
      return "Enter a label name of 1 to 50 characters.";
    case "invalid_description":
      return "Enter a description of up to 500 characters.";
    case "invalid_color":
      return "Choose one of the label colors.";
    case "duplicate_name":
      return "A label with this name already exists. Archived labels keep their names.";
    default:
      return "Could not access local label storage. Try again.";
  }
}
