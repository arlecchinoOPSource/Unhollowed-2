import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { isTauri } from "../../database/status";
import { getAppVersion } from "../../database/updates";
import { takeUpdateResume } from "./resume";
import "./updates.css";

type Notice =
  | { ok: true; version: string }
  | { ok: false; expected: string; version: string };

/**
 * After an update's restart (U2-P7-06): confirms the installed version and
 * returns to the page the person was on. Success is shown only when the
 * running version is the one that was installed. Reads only local state.
 */
export function UpdateNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isTauri()) return;
    const resume = takeUpdateResume();
    if (!resume) return;
    void getAppVersion().then(
      (version) => {
        if (version === resume.version) {
          setNotice({ ok: true, version });
          if (resume.path !== "/")
            void navigate(resume.path, { replace: true });
        } else setNotice({ ok: false, expected: resume.version, version });
      },
      () => undefined,
    );
  }, [navigate]);

  if (!notice) return null;
  return (
    <div role="status" className="update-notice">
      {notice.ok ? (
        <p>
          <strong>Unhollowed is up to date.</strong> Version {notice.version} is
          installed.
        </p>
      ) : (
        <p>
          <strong>The update to {notice.expected} did not finish.</strong> You
          still have version {notice.version}, and your workspace was not
          changed. <Link to="/updates">Try again</Link>
        </p>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => setNotice(null)}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
