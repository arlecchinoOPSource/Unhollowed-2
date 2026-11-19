import { Channel, invoke } from "@tauri-apps/api/core";

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

/** The installed app's version, as the operating system sees it. */
export function getAppVersion(): Promise<string> {
  return invoke("app_version");
}

/** Byte progress from the native download (U2-P7-05). */
export type DownloadEvent =
  | { event: "progress"; downloaded: number; total: number | null }
  /** Every byte arrived; the signature is being checked. */
  | { event: "finished" };

export type DownloadResult =
  | { status: "verified" }
  | { status: "busy" }
  | { status: "nothingToDownload" }
  | {
      status: "failed";
      reason: "offline" | "download" | "verification";
      detail: string;
    };

/**
 * Downloads the update the last check found and verifies its signature.
 * Progress arrives through `onEvent`, at most about ten times a second.
 */
export function downloadUpdate(
  onEvent: (event: DownloadEvent) => void,
): Promise<DownloadResult> {
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  return invoke("download_update", { onEvent: channel });
}
