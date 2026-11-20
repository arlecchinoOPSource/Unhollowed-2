import type { UpdateCheck, UpdateFailureReason } from "../../database/updates";

/**
 * The updater's states (U2-P7-04). Exactly one is current, so the screen can
 * never show two contradictory states. Download, verification, installation,
 * and restart are driven by later steps (U2-P7-05, U2-P7-06).
 */
export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate"; currentVersion: string }
  | {
      phase: "available";
      currentVersion: string;
      version: string;
      date: string | null;
      notes: string | null;
    }
  | {
      phase: "downloading";
      version: string;
      /** Bytes received so far, as reported by the native download. */
      downloaded: number;
      /** Total bytes, or null when the server did not say. */
      total: number | null;
    }
  | { phase: "verifying"; version: string }
  | { phase: "installing"; version: string }
  | { phase: "restarting"; version: string }
  | { phase: "error"; reason: UpdateErrorReason; detail: string };

export type UpdateErrorReason =
  | UpdateFailureReason
  | "unsupported"
  | "download"
  | "verification"
  | "install"
  | "save";

export type UpdateEvent =
  | { type: "check" }
  | { type: "checked"; result: UpdateCheck }
  | { type: "download" }
  | { type: "progress"; downloaded: number; total: number | null }
  | { type: "downloaded" }
  | { type: "verified" }
  | { type: "installed" }
  | { type: "failed"; reason: UpdateErrorReason; detail: string }
  | { type: "dismiss" };

/** States with an operation in flight. Nothing new may start in them. */
export function isBusy(state: UpdateState) {
  return (
    state.phase === "checking" ||
    state.phase === "downloading" ||
    state.phase === "verifying" ||
    state.phase === "installing" ||
    state.phase === "restarting"
  );
}

/** States the person can leave or start over from. */
const settled = new Set(["idle", "upToDate", "available", "error"]);

/**
 * The only way the state changes. An event that does not apply to the current
 * state is ignored, so late, repeated, or out-of-order events cannot produce
 * an impossible state.
 */
export function transition(
  state: UpdateState,
  event: UpdateEvent,
): UpdateState {
  switch (event.type) {
    case "check":
      return settled.has(state.phase) ? { phase: "checking" } : state;
    case "checked":
      return state.phase === "checking" ? fromCheck(event.result) : state;
    case "download":
      return state.phase === "available"
        ? {
            phase: "downloading",
            version: state.version,
            downloaded: 0,
            total: null,
          }
        : state;
    case "progress":
      return state.phase === "downloading"
        ? {
            ...state,
            // Byte counts only grow; a stale event cannot move progress back.
            downloaded: Math.max(state.downloaded, event.downloaded),
            total: event.total ?? state.total,
          }
        : state;
    case "downloaded":
      return state.phase === "downloading"
        ? { phase: "verifying", version: state.version }
        : state;
    case "verified":
      return state.phase === "verifying"
        ? { phase: "installing", version: state.version }
        : state;
    case "installed":
      return state.phase === "installing"
        ? { phase: "restarting", version: state.version }
        : state;
    case "failed":
      return state.phase === "downloading" ||
        state.phase === "verifying" ||
        state.phase === "installing"
        ? { phase: "error", reason: event.reason, detail: event.detail }
        : state;
    case "dismiss":
      return settled.has(state.phase) ? { phase: "idle" } : state;
  }
}

function fromCheck(result: UpdateCheck): UpdateState {
  switch (result.status) {
    case "available":
      return { phase: "available", ...result };
    case "current":
      return { phase: "upToDate", currentVersion: result.currentVersion };
    case "unsupported":
      return { phase: "error", reason: "unsupported", detail: result.target };
    case "failed":
      return { phase: "error", reason: result.reason, detail: result.detail };
    // The native lock found another check running. Report it rather than wait
    // for a result this request will never receive.
    case "busy":
      return {
        phase: "error",
        reason: "server",
        detail: "Another update check is already running.",
      };
  }
}
