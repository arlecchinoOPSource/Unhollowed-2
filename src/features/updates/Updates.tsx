import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { BrandMark } from "../../components/brand/BrandMark";
import { isBusy, type UpdateState } from "./updateMachine";
import { startDownload, startUpdateCheck, useUpdates } from "./updateStore";
import "./updates.css";

/**
 * What each state says. Every error names its next step. A `working` state
 * shows an animated ellipsis after its title.
 */
function describe(state: UpdateState): {
  title: string;
  detail?: string;
  working?: boolean;
} {
  switch (state.phase) {
    case "idle":
      return {
        title: "Check for updates",
        detail:
          "Unhollowed checks only when you ask. Your workspace stays on this computer.",
      };
    case "checking":
      return { title: "Checking", working: true };
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
      return { title: "Downloading update", working: true };
    case "verifying":
      return { title: "Verifying update", working: true };
    case "installing":
      return { title: "Installing update", working: true };
    case "restarting":
      return { title: "Restarting Unhollowed", working: true };
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
      return {
        title: "The update could not be downloaded",
        detail: `Try again later. ${safe}`,
      };
    case "verification":
      return {
        title: "The update could not be verified",
        detail: `Its signature did not match, so it was discarded. ${safe}`,
      };
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
  const { title, detail, working } = describe(state);

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
      <div className="updates-mark" aria-hidden="true">
        <BrandMark size={96} className={busy ? "is-breathing" : ""} />
      </div>
      {/* Announces each new state once; progress below is not live. */}
      <div
        role="status"
        aria-live="polite"
        className="updates-status"
        key={state.phase}
      >
        <p className="updates-title">
          {title}
          {working && <Ellipsis />}
        </p>
        {detail && <p className="updates-detail">{detail}</p>}
      </div>
      {state.phase === "downloading" && (
        <DownloadProgress downloaded={state.downloaded} total={state.total} />
      )}
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
        {state.phase === "available" && (
          <button
            type="button"
            className="action"
            onClick={() => void startDownload()}
          >
            Download and install
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

/** Three dots that appear in turn. Read as "..." by assistive technology. */
function Ellipsis() {
  return (
    <span className="updates-ellipsis">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

const sizeFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

/** Bytes as KB or MB, for the size under the progress bar. */
export function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${sizeFormat.format(bytes / 1024)} KB`
    : `${sizeFormat.format(bytes / 1024 / 1024)} MB`;
}

/**
 * Progress from the bytes actually received. With no total (or a total of
 * zero), the bar is indeterminate and no percentage is shown.
 */
export function DownloadProgress({
  downloaded,
  total,
}: {
  downloaded: number;
  total: number | null;
}) {
  const known = total && total > 0 ? total : null;
  const percent = known
    ? Math.min(100, Math.floor((downloaded / known) * 100))
    : null;
  const text =
    percent === null || known === null
      ? `${formatBytes(downloaded)} downloaded`
      : `${percent}% · ${formatBytes(downloaded)} of ${formatBytes(known)}`;
  return (
    <div className="updates-progress">
      <div
        role="progressbar"
        aria-label="Download progress"
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? `${text}, size unknown` : text}
        className={`updates-track${percent === null ? " is-indeterminate" : ""}`}
      >
        <div
          className="updates-fill"
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="updates-detail">{text}</p>
    </div>
  );
}
