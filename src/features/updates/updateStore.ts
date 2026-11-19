import { create } from "zustand";
import { checkForUpdate, downloadUpdate } from "../../database/updates";
import {
  isBusy,
  transition,
  type UpdateEvent,
  type UpdateState,
} from "./updateMachine";

/**
 * The one updater state for the whole app, so the sidebar button and the
 * updater screen always agree. Nothing here runs until the person asks.
 */
export const useUpdates = create<{
  state: UpdateState;
  send: (event: UpdateEvent) => void;
}>()((set) => ({
  state: { phase: "idle" },
  send: (event) => set(({ state }) => ({ state: transition(state, event) })),
}));

/**
 * Starts a check unless an operation is already running. Repeated activation
 * while busy does nothing, so at most one operation is ever in flight.
 */
export async function startUpdateCheck() {
  const { state, send } = useUpdates.getState();
  if (isBusy(state)) return;
  send({ type: "check" });
  const result = await checkForUpdate().catch((error: unknown) => ({
    status: "failed" as const,
    reason: "server" as const,
    detail: String(error),
  }));
  send({ type: "checked", result });
}

/**
 * Downloads and verifies the update the person chose to install. Progress
 * comes from the bytes the native download received; nothing is estimated.
 */
export async function startDownload() {
  const { state, send } = useUpdates.getState();
  if (state.phase !== "available") return;
  send({ type: "download" });
  const result = await downloadUpdate((event) =>
    send(
      event.event === "progress"
        ? {
            type: "progress",
            downloaded: event.downloaded,
            total: event.total,
          }
        : { type: "downloaded" },
    ),
  ).catch((error: unknown) => ({
    status: "failed" as const,
    reason: "download" as const,
    detail: String(error),
  }));
  switch (result.status) {
    case "verified":
      send({ type: "downloaded" });
      // shortcut: installation arrives in U2-P7-06; until then a verified
      // package stops here, with nothing changed.
      send({
        type: "failed",
        reason: "install",
        detail: "Installing updates is not available in this version yet.",
      });
      return;
    case "failed":
      send({ type: "failed", reason: result.reason, detail: result.detail });
      return;
    case "busy":
    case "nothingToDownload":
      send({ type: "failed", reason: "download", detail: result.status });
  }
}
