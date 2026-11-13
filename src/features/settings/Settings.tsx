import { useState } from "react";
import { isTauri, readDatabaseStatus } from "../../database/status";

export function Settings() {
  const desktop = isTauri();
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);

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
        <p>
          {desktop
            ? "Check the connection to your workspace database."
            : "Local SQLite storage is available in the desktop app."}
        </p>
        {desktop && (
          <button className="action" onClick={checkStorage} disabled={checking}>
            Check local storage
          </button>
        )}
        <p role="status">{message}</p>
      </section>
    </>
  );
}
