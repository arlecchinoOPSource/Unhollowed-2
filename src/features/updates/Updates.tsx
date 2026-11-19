import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { isBusy, type UpdateState } from "./updateMachine";
import { startUpdateCheck, useUpdates } from "./updateStore";
import "./updates.css";

/** What each state says. Every error names its next step. */
function describe(state: UpdateState): { title: string; detail?: string } {
  switch (state.phase) {
    case "idle":
      return {
        title: "Check for updates",
        detail:
          "Unhollowed checks only when you ask. Your workspace stays on this computer.",
      };
    case "checking":
      return { title: "Checking…" };
    case "upToDate":
      return {
        title: "Unhollowed is up to date",
        detail: `You have the latest version, ${state.currentVersion}.`,
      };
    case "available":
      return {
        title: `Version ${state.version} is available`,
        detail: `You have version ${state.currentVersion}.`,
      };
    case "downloading":
      return { title: "Downloading update…" };
    case "verifying":
      return { title: "Verifying update…" };
    case "installing":
      return { title: "Installing update…" };
    case "restarting":
      return { title: "Restarting Unhollowed…" };
    case "error":
      return errorText(state.reason);
  }
}

function errorText(reason: Extract<UpdateState, { phase: "error" }>["reason"]) {
  const safe = "Nothing was changed, and your workspace is not affected.";
  switch (reason) {
    case "offline":
      return {
        title: "Could not reach the update server",
        detail: `Check your internet connection and try again. ${safe}`,
      };
    case "unsupported":
      return {
        title: "Updates are not available here",
        detail:
          "This computer or installer has no in-app updates. Download new versions from the Unhollowed releases page.",
      };
    case "invalidMetadata":
    case "server":
      return {
        title: "The update server did not answer correctly",
        detail: `Try again later. ${safe}`,
      };
    case "download":
    case "verification":
    case "install":
      return {
        title: "The update could not be installed",
        detail: `Try again later. ${safe}`,
      };
  }
}

export function Updates() {
  const state = useUpdates((store) => store.state);
  const send = useUpdates((store) => store.send);
  const navigate = useNavigate();
  const location = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const busy = isBusy(state);
  const { title, detail } = describe(state);

  useEffect(() => heading.current?.focus(), []);

  // Leaves the screen and gives focus back to the button that opened it.
  function done() {
    send({ type: "dismiss" });
    if (location.key === "default") void navigate("/");
    else void navigate(-1);
    requestAnimationFrame(() =>
      document.getElementById("update-button")?.focus(),
    );
  }

  return (
    <section className="updates" aria-labelledby="updates-heading">
      <h1 id="updates-heading" ref={heading} tabIndex={-1}>
        Updates
      </h1>
      <div role="status" aria-live="polite" className="updates-status">
        <p className="updates-title">{title}</p>
        {detail && <p className="updates-detail">{detail}</p>}
      </div>
      {state.phase === "available" && state.notes && (
        <div className="updates-notes">
          <h2>What’s new</h2>
          <p>{state.notes}</p>
        </div>
      )}
      <div className="updates-actions">
        {(state.phase === "idle" || state.phase === "upToDate") && (
          <button
            type="button"
            className="action"
            onClick={() => void startUpdateCheck()}
          >
            {state.phase === "idle" ? "Check for updates" : "Check again"}
          </button>
        )}
        {state.phase === "error" && state.reason !== "unsupported" && (
          <button
            type="button"
            className="action"
            onClick={() => void startUpdateCheck()}
          >
            Try again
          </button>
        )}
        {/* A check only reads, so leaving during it is safe; its result waits here. */}
        {(!busy || state.phase === "checking") && (
          <button type="button" className="action" onClick={done}>
            Done
          </button>
        )}
      </div>
    </section>
  );
}
