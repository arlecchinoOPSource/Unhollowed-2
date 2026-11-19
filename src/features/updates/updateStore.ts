import { create } from "zustand";
import { checkForUpdate } from "../../database/updates";
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
