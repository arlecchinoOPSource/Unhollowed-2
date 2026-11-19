import { ArrowDownToLine } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { startUpdateCheck } from "./updateStore";
import "./updates.css";

/**
 * The sidebar's updater control. It is the only way a check starts: nothing
 * checks at startup, on a timer, or in the background.
 */
export function UpdateButton() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <button
      type="button"
      id="update-button"
      className="update-button"
      aria-label="Check for updates"
      title="Check for updates"
      aria-current={pathname === "/updates" ? "page" : undefined}
      onClick={() => {
        // Does nothing while an update operation is already running.
        void startUpdateCheck();
        void navigate("/updates");
      }}
    >
      <ArrowDownToLine size={18} aria-hidden="true" />
      <span className="nav-label">Updates</span>
    </button>
  );
}
