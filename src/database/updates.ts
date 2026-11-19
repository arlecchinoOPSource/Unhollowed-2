import { invoke } from "@tauri-apps/api/core";

/** Why a check failed. Nothing was downloaded or changed; the person can retry. */
export type UpdateFailureReason = "offline" | "invalidMetadata" | "server";

/** The result of one update check, from `src-tauri/src/updates.rs`. */
export type UpdateCheck =
  | {
      status: "available";
      currentVersion: string;
      version: string;
      date: string | null;
      notes: string | null;
    }
  | { status: "current"; currentVersion: string }
  /** No updater packages exist for this platform or installer. */
  | { status: "unsupported"; target: string }
  /** Another check is already running. */
  | { status: "busy" }
  | { status: "failed"; reason: UpdateFailureReason; detail: string };

/**
 * Asks the beta channel whether a newer version exists. Call it only from an
 * explicit user action: never at startup, on a timer, or in the background.
 */
export function checkForUpdate(): Promise<UpdateCheck> {
  return invoke("check_for_update");
}
