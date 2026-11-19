import { useEffect, useState } from "react";
import { isTauri, readDatabaseStatus } from "../../database/status";
import { getAppVersion } from "../../database/updates";
import { DataSettings } from "./DataSettings";

export function Settings() {
  const desktop = isTauri();
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (desktop) void getAppVersion().then(setVersion, () => setVersion(""));
  }, [desktop]);

  async function checkStorage() {
    setChecking(true);
    setMessage("Checking local storage…");
    try {
      const { workspaceName } = await readDatabaseStatus();
      setMessage(
        `SQLite is ready. Workspace “${workspaceName}” was read from local storage.`,
      );
    } catch {
      setMessage("Could not read the workspace from local storage.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <h1>Settings</h1>
      <section aria-labelledby="storage-heading" className="settings-section">
        <h2 id="storage-heading">Local storage</h2>
        {desktop && (
          <button className="action" onClick={checkStorage} disabled={checking}>
            Check local storage
          </button>
        )}
        <p role="status">{message}</p>
      </section>
      {desktop && <DataSettings />}
      {desktop && (
        <section aria-labelledby="about-heading" className="settings-section">
          <h2 id="about-heading">About</h2>
          <p>{version ? `Unhollowed ${version}` : "Unhollowed"}</p>
        </section>
      )}
    </>
  );
}
