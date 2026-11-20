import { create } from "zustand";
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
} from "../../database/updates";
import { flushDocumentWrites } from "../documents/editor/drafts";
import { forgetUpdate, rememberUpdate } from "./resume";
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
  /** The page the person opened the updater from, restored after an update. */
  returnTo: string;
}>()((set) => ({
  state: { phase: "idle" },
  returnTo: "/",
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
      send({ type: "verified" });
      // "Download and install" was the person's confirmation to install.
      await startInstall();
      return;
    case "failed":
      send({ type: "failed", reason: result.reason, detail: result.detail });
      return;
    case "busy":
    case "nothingToDownload":
      send({ type: "failed", reason: "download", detail: result.status });
  }
}

/**
 * Hands over to the installer, but only after every document edit is saved.
 * The native side also waits for database writes to finish. If anything
 * fails, the app and workspace stay open and the error says what to do.
 */
async function startInstall() {
  const { state, send, returnTo } = useUpdates.getState();
  if (state.phase !== "installing") return;
  try {
    await flushDocumentWrites();
  } catch (error) {
    send({ type: "failed", reason: "save", detail: String(error) });
    return;
  }
  rememberUpdate({ version: state.version, path: returnTo });
  const result = await installUpdate(() => send({ type: "installed" })).catch(
    (error: unknown) => ({
      status: "failed" as const,
      reason: "install" as const,
      detail: String(error),
    }),
  );
  // Reaching here means the app did not restart: nothing was installed.
  forgetUpdate();
  send({
    type: "failed",
    reason: "install",
    detail: result.status === "failed" ? result.detail : result.status,
  });
}
